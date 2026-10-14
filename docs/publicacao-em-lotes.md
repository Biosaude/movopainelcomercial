# Publicação integral de bases maiores que 3 MB

## Diagnóstico

O limite de 3 MB era uma proteção criada pela aplicação, não uma medida do tamanho do Excel nem um limite de 13 mil registros:

1. `publicationSchema` validava `TextEncoder(JSON.stringify(payload)).byteLength` e rejeitava a publicação antes de iniciar o transporte. A seção de gerenciamento e o backend usavam essa mesma validação.
2. `dashboard_publish`, na migration original, também rejeita `octet_length(p_faturamento::text) + octet_length(p_metas::text) > 3000000`. A representação JSONB pode conter mais espaços que o JSON do navegador.
3. Elevar apenas o limite no cliente transferiria todo o JSON numa requisição e ainda falharia no SQL original ou no limite HTTP do provedor.

As contagens informadas (13.759 faturamentos e 633 metas) cabem nas restrições de 25.000 registros por tabela existentes. O bloqueio ocorre pelos bytes: nomes, dimensões opcionais, datas e campos comerciais são repetidos em cada linha. Não foi recebida nem gravada a planilha real nesta implementação. Os testes reproduzem suas contagens validadas com dados fictícios e mantêm integralmente ambos os arrays; não removem registros para ajustar tamanho. A contagem de linhas lidas pode incluir linhas agrupadas pelo parser de metas existente, cuja regra permanece inalterada.

## Limites e observações de transporte

| Camada                        | Limite ou comportamento                                                                                                                       | Tratamento                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Validação antiga              | 3.000.000 bytes para a base inteira                                                                                                           | Mantida somente no endpoint monolítico de compatibilidade; o fluxo novo valida a estrutura completa e limita cada lote             |
| SQL original                  | 3.000.000 bytes no `dashboard_publish`                                                                                                        | Função e migration executada permanecem intactas; RPCs adicionais recebem e concluem lotes                                         |
| Vercel Functions              | Limite documentado de 4,5 MB para requisição/resposta; respostas por streaming têm regras diferentes                                          | Requisições e páginas pequenas; nenhuma dependência de streaming ou de aumentar esse teto                                          |
| Supabase Data API / PostgREST | Não há uma regra de 3 MB no schema além da RPC criada para este projeto. Contagens de resultados, memória, gateway e timeouts também importam | RPCs escalares JSONB, páginas de até 500 registros e conferência dos totais evitam truncamento por limites de linhas               |
| PostgreSQL                    | Limite teórico de 1 GB por campo; não representa uma capacidade operacional segura de requisição                                              | Cada JSONB de preparação fica limitado pelo lote, nunca contendo a base inteira                                                    |
| Supabase SQL                  | Defaults documentados: `anon` 3 s, `authenticated` 8 s; o projeto pode ter valores diferentes                                                 | Operações pequenas e contadores pré-calculados; conclusão em massa testada localmente. Nenhum timeout global ou papel foi alterado |
| Excel local                   | 10 MB por arquivo, já existente na interface                                                                                                  | Mantido; bytes do Excel comprimido e do JSON são medidas distintas                                                                 |

Fontes de referência: [Vercel Functions limits](https://vercel.com/docs/functions/limitations), [Supabase timeouts](https://supabase.com/docs/guides/database/postgres/timeouts), [Supabase select](https://supabase.com/docs/reference/javascript/select) e [PostgreSQL limits](https://www.postgresql.org/docs/current/limits.html). Os defaults de timeout e o limite por campo foram conferidos nas fontes oficiais disponíveis no GitHub ([Supabase](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/database/postgres/timeouts.mdx), [PostgreSQL](https://github.com/postgres/postgres/blob/master/doc/src/sgml/limits.sgml)). A página pública da Vercel retornou bloqueio de rede no ambiente; o teto de 4,5 MB é a referência documentada, não uma medição do deployment remoto. Não foi feito teste de carga em produção.

Supabase Storage e Edge Functions não participam deste protocolo. Limites de arquivo de buckets não precisam ser alterados. A infraestrutura real pode ainda impor limites de tempo, espaço e tráfego; isso não é resolvido enviando a base de uma só vez.

## Protocolo implementado

1. O cliente valida toda a base com as regras e tipos existentes e aplica a mesma normalização de datas/UFs. Não há nova agregação, cálculo financeiro, deduplicação de faturamento ou redução de metas.
2. `prepareUpload` divide os registros em lotes de até **500 linhas** e **500.000 bytes UTF-8**, preservando ordem e contagens. A serialização ordena apenas as chaves dos objetos, sem alterar os valores. Cada lote recebe um SHA-256.
3. O manifesto contém UUID da importação, versão esperada, arquivo, totais e descritores de posição/contagem/checksum. Ele é enviado ao backend pela operação `beginSharedUpload`.
4. Cada `appendSharedUpload` transporta somente um lote. O backend valida sessão e permissão; o PostgreSQL verifica novamente administrador, proprietário da preparação, checksum, estrutura e contagem. Um lote repetido com o mesmo conteúdo não gera uma nova linha. Conteúdo diferente para o mesmo identificador é rejeitado.
5. `commitSharedUpload` é chamado somente depois da confirmação de todos os lotes. A função SQL verifica a preparação completa, bloqueia o ponteiro ativo e confere a versão esperada. Na **mesma transação**, insere histórico, faturamento e metas, confere os totais, troca o ponteiro ativo e marca a preparação concluída.
6. Uma falha na conclusão desfaz histórico, faturamento, metas e ponteiro juntos. Uma falha intermediária deixa apenas preparação privada; a base anterior permanece pública. Repetir a mesma seleção retoma usando os mesmos UUID e checksums. O servidor mantém a precondição original, mesmo que o navegador tenha recarregado a base.
7. Uma conclusão já registrada retorna o mesmo UUID sem novas inserções. O cliente mantém a correção do PR #23: compara esse UUID com a versão realmente ativa e avisa caso outra publicação já o tenha substituído. Repetir uma publicação histórica não reativa nem sobrescreve a versão mais recente.

Todas as operações administrativas são feitas pelo backend com o token do usuário, validado por Supabase Auth. A permissão administrativa e a propriedade são novamente verificadas pelas RPCs SQL. Não há chave `service_role`, bucket público de upload nem gravação direta das tabelas pelo navegador. RLS permanece ativa. Um administrador não pode assumir a preparação de outro.

## Leitura de versões grandes

Dividir o upload seria insuficiente se uma abertura posterior tentasse devolver toda a versão de 10 MB por uma função Vercel. `dashboard_read_manifest` retorna apenas metadados e uma estimativa conservadora do volume. Novas versões usam os pequenos contadores dos lotes já armazenados; versões anteriores são compatíveis por cálculo no banco.

Versões pequenas continuam chegando pelo loader inicial. Versões maiores são transferidas por `dashboard_read_page`, com até 500 registros e aproximadamente 400 KB por página, sempre para um ID fixo. O cliente confere avanço, tamanho e total dos arrays e só aplica o snapshot quando todos os faturamentos e metas chegaram. Não há publicação nem atualização visual com metade de uma base. Uma mudança de versão durante a leitura é rejeitada, permitindo recarga sem misturar versões. Uma leitura substituída por outra sessão é descartada.

A leitura pública conserva a regra de acesso definida para este projeto e permite apenas a versão ativa; preparações e versões arquivadas não ficam acessíveis pelos novos endpoints públicos. O histórico administrativo e os e-mails dos responsáveis permanecem restritos. Layout, JSX dos cards, KPIs, filtros, gráficos, rankings e fórmulas não foram alterados.

## SQL adicional e ordem de ativação

O arquivo original `20261014130000_dashboard_shared_versions.sql` **não deve ser reaplicado nem editado**. O projeto já integrado precisa executar, após revisão, somente:

`supabase/migrations/20261014160000_dashboard_batch_uploads.sql`

Esse SQL cria `dashboard_uploads`, `dashboard_upload_chunks` e as funções `dashboard_upload_begin`, `dashboard_upload_chunk`, `dashboard_upload_commit`, `dashboard_read_manifest` e `dashboard_read_page`, com privilégios e RLS próprios. Não contém remoção de tabelas, substituição de funções anteriores ou atualização de dados existentes. Criar o schema adicional não altera o ponteiro da versão ativa. O código novo depende dessas funções; aplicar o SQL antes de autorizar o deployment.

Em projeto de teste novo, aplicar a migration original e depois esta adicional. As migrations históricas anteriores à estrutura do dashboard não devem ser reaplicadas indiscriminadamente: contêm operações destrutivas e dependências de outro schema.

As variáveis existentes `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` continuam sendo suficientes. Não há nova chave, configuração de bucket ou ampliação do limite HTTP necessária. A branch `codex/publicacao-base-em-lotes` desativa deployment automático no `vercel.json` para permitir revisão antes da ativação.

## Testes e resultados

Dados fictícios: **13.759 registros de faturamento e 633 metas**, total de **10.491.467 bytes** no JSON gerado. Um Excel de teste comprimido abaixo de 10 MB representa essa base inteira.

- `bun test`: 46 testes passaram, incluindo divisão por bytes Unicode, contagens, checksums estáveis, falha intermediária, ausência de commit prematuro, retomada, leitura integral e rejeição de páginas truncadas ou substituídas.
- `bun run test:sql`: PostgreSQL 17 descartável, sem rede. Publicação e leitura integral preservaram todas as linhas, ordem, valores e somatórios financeiros. Passaram permissão, isolamento de proprietário, checksum inválido, lote repetido, conclusão incompleta, reenvio idempotente, falha após inserir faturamento e dois administradores concorrentes. O arquivo original de migration foi utilizado sem alterações. A conclusão da base grande levou entre **1,1 e 1,6 s nas execuções nesse banco local**; isso não constitui benchmark do projeto remoto.
- `bun run test:e2e`: fluxo original, regressões P2 e fluxo grande passaram. Uma falha no terceiro lote manteve a versão anterior; a segunda tentativa publicou a base completa. Recarga e novo visitante recuperaram 13.759 faturamentos e 633 metas. Na medição do HTTP real do framework local, a maior requisição foi **479.657 bytes** e a maior resposta **498.128 bytes**.
- TypeScript (`tsc --noEmit`), lint específico dos módulos alterados e build Vercel passaram. O lint geral conserva as pendências de formatação preexistentes.

Os testes SQL e HTTP criam seus próprios bancos e recebem somente identificadores de containers descartáveis locais; nunca aceitam URL de banco de produção. Nenhuma planilha real, migração ou dado do Supabase remoto foi escrito, alterado ou removido.

## Operação e limitações

Preparações não concluídas expiram após 24 horas; uma preparação expirada exige selecionar novamente o arquivo, gerando um UUID novo. Preparações, lotes e versões publicadas ficam preservados para auditoria e repetição segura. Não há exclusão automática. É necessário dimensionar espaço para preparação e histórico e definir uma política futura de retenção; este PR não elimina dados existentes.

Se a conclusão exceder o timeout do projeto, a transação é cancelada e a base anterior continua ativa. Verificar os tempos reais em projeto de teste antes de autorizar produção. Caso necessário, um operador pode propor um timeout específico para a função de conclusão e a duração correspondente no Vercel, respeitando os limites do plano; nenhum timeout foi aumentado automaticamente. Não aumentar globalmente os timeouts ou usar service_role para contornar uma falha de autorização.

A contagem máxima de 25.000 registros por tabela e o limite local de arquivo permanecem. O protocolo remove o limite de 3 MB da base completa, não torna memória, armazenamento ou duração de execução ilimitados. Em bases acima das contagens já existentes, será necessário outro SQL adicional revisado; os limites nunca são atendidos truncando os arrays.

Após revisão: testar o SQL adicional em ambiente separado, confirmar os administradores existentes, autorizar o deployment e publicar a planilha validada. Conferir arquivo/data, 13.759 faturamentos, 633 metas e reconciliação; abrir outro navegador. No ambiente real, não substituir dados por planilhas fictícias para reproduzir os testes automatizados.
