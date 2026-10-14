# Auditoria do Dashboard Comercial — main com PRs #23 e #24

Referência: `6539083`, merge do PR #24. A execução utiliza bases fictícias e PostgreSQL 17 descartável. Não houve acesso de escrita ao Supabase publicado, alteração de migrations, histórico remoto, merge ou deploy.

## Diagnóstico e correções

### KPIs e erro de UF

A `main` já formata os KPIs com `fmtCompact`, incluindo `R$ 77,5 mi`. Não há `Intl` com notação compacta longa nem texto `milhões` nesse caminho. Não foi necessário alterar valores, precisão, agregações ou fórmulas.

O documento, porém, declarava `lang="en"` para conteúdo português. Um tradutor pode expandir abreviações e substituir os nós de texto que o React administra. Em teste de navegador na referência, a substituição dos textos do resumo “Exibindo todos os registros” por elementos `font`, seguida da seleção de UF, reproduziu `NotFoundError: Failed to execute 'removeChild' on 'Node'`. O erro surgiu no commit do componente `Text` do React e abriu a mesma tela de erro da aplicação. Os 14 filtros, sem essa interferência, funcionaram na reprodução inicial. Isso identifica uma causa reproduzível compatível com o relato; sem logs do navegador de produção, não comprova qual extensão ou tradutor o visitante utilizou.

Correção: documento em `pt-BR`, `translate="no"` e metadata `google/notranslate`. O resumo dos filtros possui chaves distintas para estado inicial e estado ativo, fazendo o React substituir o elemento inteiro em vez de tentar excluir textos que um tradutor retirou. O teste também simula um modificador que ignora `translate="no"`, verificando que a primeira seleção de UF não derruba a página. Não há monkey patch de APIs do DOM nem captura que esconda erros de cálculo.

As opções dos filtros também continham um botão Radix Checkbox dentro de outro botão. O navegador registrava marcação inválida. A caixa utiliza agora um `span` com o mesmo componente/estilo; o botão de opção declara `aria-pressed`. A aparência e o comportamento de seleção são preservados.

Além disso, na troca rápida entre filtros, o menu anterior ainda estava em animação de saída quando recuperava o foco, fazendo o menu seguinte fechar. O caso UF do Hospital = AP seguido de UF = PA reproduziu a falha de interação. O `onCloseAutoFocus` agora preserva o foco quando outro menu/diálogo já está aberto; a devolução normal de foco continua funcionando nos demais casos. A reprodução isolada passou após a mudança. Os testes procuram apenas o menu com `data-state="open"`.

### Gerenciamento administrativo

Anteriormente, apenas a publicação permanente exigia administrador na interface; modelo, seleção de arquivo e prévia temporária estavam disponíveis publicamente. Os quatro controles agora permanecem visíveis e desabilitados para visitantes e contas sem autorização. O input de arquivo também é desabilitado, e os handlers e o callback de aplicação verificam a permissão.

Antes de baixar o modelo, ler a planilha ou aplicar a prévia, um endpoint do TanStack Start valida o JWT com Supabase Auth e consulta `dashboard_is_admin`. Essa autorização não recebe nem grava planilhas. A publicação continua com seus handlers, RPCs e RLS existentes. A análise pública não depende desse endpoint administrativo.

Ao mudar de ator, a seleção local é descartada; operações assíncronas de seleção não podem atravessar uma mudança de permissão. Uma falha transitória de leitura com o mesmo ator preserva o UUID da seleção, necessário para a retomada idempotente. A prévia fica oculta sem permissão. Logout/perda de permissão restaura a versão compartilhada na análise, mesmo se a leitura seguinte falhar. A permissão do ator anterior não fica disponível enquanto uma nova sessão está sendo verificada.

### Modelo Excel grande

A geração original usava XLSX sem compressão. Com a base fictícia completa da auditoria, o mesmo conteúdo resultou em **18.574.762 bytes**, acima do limite existente de 10 MB para selecionar uma planilha. A publicação em lotes tornou esse descompasso visível para bases maiores.

O modelo agora utiliza compressão ZIP nativa do XLSX, sem modificar suas colunas ou valores. Na medição do conteúdo equivalente, ficou com **3.714.340 bytes**. O teste de navegador valida o arquivo efetivamente baixado: tamanho dentro do limite, 13.759 faturamentos, 633 metas e somatórios financeiros preservados, inclusive quando o administrador está com filtro ativo.

## Integridade e equivalência

O dashboard continua sendo uma única rota e um único conjunto de componentes. Visitante e administrador analisam a mesma versão ativa, pelos mesmos filtros, normalizadores, cálculos, metas, gráficos, rankings e drill-down. O histórico e as ações de base são administrativos; a prévia temporária é uma ação explícita do administrador.

O protocolo de lotes, montagem privada das páginas, contagens, controle de versão, idempotência, ativação atômica, rollback e concorrência não foi alterado. Os arquivos `batches.ts`, `upload.server.ts`, `dashboard-upload.functions.ts`, `domain.ts`, `drilldown.ts` e as duas migrations permanecem iguais à referência.

A `main` não contém um download analítico independente: seu download existente é “Baixar Modelo da Base”, explicitamente restrito pelo pedido. Nenhuma exportação analítica existente foi removida, e não foi criado um novo fluxo visual de exportação.

## Arquivos modificados

| Arquivo | Finalidade |
| --- | --- |
| `src/routes/__root.tsx` | Idioma e proteção contra tradução automática. |
| `src/routes/index.tsx` | Chaves do resumo dos filtros, guarda da prévia, restauração da versão publicada ao perder permissão e desativação de animação em gráficos grandes. |
| `src/components/dashboard/MultiSelectFilter.tsx` | Remoção de botões aninhados e proteção do foco na troca rápida de filtros, sem mudança de aparência. |
| `src/components/dashboard/BaseManagement.tsx` | Controles e handlers restritos, validação administrativa, identidade da seleção e compressão do modelo Excel. |
| `src/hooks/use-shared-dashboard.ts` | Autorização dos fluxos locais e invalidação da permissão ao trocar sessão. |
| `src/lib/api/dashboard.functions.ts` | Endpoint de autorização de gerenciamento. |
| `src/lib/dashboard/shared.server.ts` | Validação remota de sessão e papel administrativo. |
| `tests/currency-format.test.ts` | Abreviações e precisão monetária. |
| `tests/shared-dashboard.test.ts` | Sessões ausentes/inválidas, visitante e administrador no guard do servidor. |
| `tests/dashboard-audit.e2e.mjs` | Auditoria funcional, equivalência, tradução, filtros, falhas e permissões. |
| `tests/support/audit-dataset.mjs` | Base fictícia completa com várias dimensões e valores verificáveis. |
| `tests/support/supabase-fixture.ts` | Injeção local de falha de página e negativa de autorização. |
| `tests/e2e.mjs` | Expectativas públicas atualizadas para controles desabilitados; fluxo administrativo preservado. |
| `tests/run-e2e.sh` | Inclui a auditoria na suíte completa e aguarda o listener definitivo do PostgreSQL, evitando uma corrida com o servidor temporário de inicialização. |
| `tests/large-publication.e2e.mjs` | Confirma que o ranking grande conserva as 13.759 barras. |
| `vercel.json` | Desativa deploy automático da branch deste PR. |
| `docs/auditoria-regressoes.md` | Diagnóstico, evidência e limites da auditoria. |

## Validação

- `bun test`: **49 testes passaram, 0 falhas**, 7.549 asserções, incluindo as regressões comerciais anteriores, formatação monetária e validação administrativa no servidor.
- `tsc --noEmit`: **passou**.
- `bun run test:sql`: **passou** no PostgreSQL 17 descartável. Verificou RLS, ausência de escrita não autorizada, staging privado, checksums, falha intermediária, repetição sem duplicação, integridade de 13.759/633 registros e dos valores/ordem, rollback após falha tardia, concorrência entre administradores e preservação de versão mais recente. As migrations foram usadas sem alterações.
- `bun run test:e2e`: **passou, código de saída 0**. Inclui fluxo administrativo/publicação, as seis regressões P2 anteriores, a publicação de JSON fictício com **10.491.467 bytes** e a nova auditoria. A maior requisição real da função foi **479.657 bytes** e a maior resposta **498.128 bytes**. Confirmou 13.759 barras de representantes sem truncamento.
- A auditoria comparou **19 cenários por ator (38 execuções funcionais, com 19 comparações entre perfis)**: ausência de filtros, cada um dos 14 filtros, UF múltipla, combinação de período/UF, combinação de todas as dimensões e combinação incompatível sem resultados. KPIs, valores completos dos tooltips, contagens, MV/MF, coberturas, reconciliação dos gráficos e rankings foram conferidos contra os valores esperados, além da igualdade dos conteúdos analíticos entre os atores.
- Passaram drill-down/totais e igualdade das tabelas, busca de médico sem alteração dos KPIs, falha de página mantendo o conjunto anterior completo, recuperação/recarga, logout durante prévia com falha de leitura, replay HTTP sem token/com visitante/token inválido e negativa de permissão após login. O arquivo Excel baixado foi lido e conferido: **3.714.340 bytes**, **13.759 faturamentos**, **633 metas**, somatórios intactos.
- Viewport móvel **390 × 844**: UF e combinação com ano/mês/UF do cliente recalcularam os valores corretamente e não houve overflow horizontal. A indisponibilidade do IBGE manteve os valores e exibiu o fallback do mapa. Não houve erros de execução nem avisos de marcação React nos cenários finais.
- Memória, após coleta de lixo explícita no Chromium local: **33,8 → 43,1 MiB** após três recargas completas. O aumento ficou abaixo do limite de retenção de 50 MiB usado no teste. O ciclo de auditoria levou aproximadamente **15,7 min**, incluindo interações, esperas por animação, exportação e recargas; essa duração não é a latência de um filtro nem um benchmark da Vercel.
- ESLint dos módulos de servidor/hook/testes formatados: **passou**. A verificação dos componentes legados, com a regra de formatação desativada para preservar o diff pontual, terminou com **0 erros e 17 avisos preexistentes** de dependências de `useMemo` na rota principal.
- `bun run build:vercel`: **passou**, código de saída 0, saída de produção `.vercel/output` gerada para Node 24.

## Riscos e limites

- Os dados reais e o ambiente remoto não foram usados como fixtures. A validação ocorre com a mesma contagem informada, 13.759 faturamentos e 633 metas, sem descartar registros. O console do visitante em produção ainda é necessário para confirmar a origem exata da interferência externa relatada.
- A aplicação precisa de uma consulta administrativa adicional para cada ação local de gerenciamento. Uma indisponibilidade impede essa ação; as análises publicadas continuam disponíveis.
- As bases completas permanecem em memória, e os rankings existentes não são virtualizados. Um teste extremo com um representante diferente em cada registro exigiu renderização e memória elevadas. Não foram cortadas barras, rankings ou dados para esconder esse custo. Foi desabilitada apenas a animação nos gráficos com mais de 200 itens, preservando altura, estilos, todos os rótulos e todas as barras. O teste grande confirma 13.759 barras de representantes. Os testes de equivalência usam representantes agrupados, além do teste grande existente com nomes únicos. Uma eventual virtualização exige avaliação própria para preservar a visualização.
- O modelo mantém as colunas legadas de metas. Campos opcionais como mês e UF do hospital da meta não fazem parte desse modelo; ele não deve ser tratado como backup de todos os campos do JSON publicado. A compressão preserva essa estrutura existente.
- O mapa depende do IBGE. O teste funcional usa uma resposta GeoJSON fictícia com as 27 UFs; isso não atesta disponibilidade do serviço externo.
- `translate="no"` depende do respeito do navegador/extensões. A correção pontual de atualização do resumo cobre a falha reproduzida; extensões que substituam arbitrariamente outros componentes ainda podem interferir no DOM.
- Não há SQL adicional ou novas variáveis de ambiente para este PR. As migrations dos PRs anteriores devem continuar instaladas; não devem ser reexecutadas por causa desta correção.
