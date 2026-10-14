# Dashboard Comercial: integração com Supabase

## Diagnóstico

O projeto usa React 19, TanStack Start, TypeScript, Vite 7, Nitro e Bun. A rota `src/routes/index.tsx` contém os filtros, KPIs, rankings, gráficos, reconciliação e drill-down. `src/lib/dashboard/domain.ts` interpreta Excel com SheetJS, normaliza representantes/UFs, agrega metas sem duplicar e aplica o rateio mensal já autorizado de 1/3 por quarter. A UF principal segue a UF do Hospital; UF do Cliente permanece independente.

Antes desta integração, os JSONs de `src/data` e o `localStorage` alimentavam o painel. Uma importação atualizava somente aquele navegador. Os clientes Supabase e o middleware existentes não consultavam nem persistiam a base comercial. As migrações antigas usam outra estrutura e incluem operações destrutivas.

Os cálculos, filtros, dimensões, rankings, componentes de gráficos/mapa, exportação e estrutura Excel foram mantidos. O parser original atende a planilha combinada e duas planilhas separadas. Uma correção de validação rejeita texto não numérico: antes, uma célula como `invalid` era convertida silenciosamente em zero. Não foram alteradas fórmulas financeiras, normalização comercial ou agregações.

O repositório do Dashboard de Retenção não foi informado. Esta implementação segue o comportamento solicitado e reutiliza a arquitetura deste projeto; não afirma reproduzir o código daquele dashboard.

## Comportamento

Cada abertura consulta o Supabase pelo backend, inclusive durante a renderização inicial. Um `localStorage` antigo nunca substitui a base compartilhada. A leitura retorna uma única versão de faturamento e metas, com identificação do arquivo, data e contagens.

A prévia temporária altera apenas a memória do navegador e pode ser publicada depois de conferida. Recarregar ou consultar novamente a base compartilhada descarta a prévia. A publicação permanente exige login, permissão administrativa, dados válidos e confirmação explícita. Se houver linhas descartadas como inválidas, a publicação fica bloqueada até a correção; a prévia continua disponível. Publicar sem metas exige confirmação avisando que a nova base ficará sem metas.

Se não houver versão publicada e a leitura estiver autorizada, a base embarcada permanece disponível, identificada como tal. Os JSONs embarcados agora são carregados exclusivamente no servidor, sem inclusão estática nos assets do navegador. Em produção sem Supabase configurado, o painel informa que a configuração está pendente. Falhas de leitura nunca trocam silenciosamente a base ativa. Uma página já aberta pode preservar sua última leitura, exibindo o erro. Para consultar publicações feitas depois de abrir a página, o visitante usa “Recarregar base compartilhada” ou reabre o site; não há atualização em tempo real.

## Migração e segurança

Revisar e aplicar **somente** `supabase/migrations/20261014130000_dashboard_shared_versions.sql` ao projeto correto. Ela cria:

| Tabela                  | Finalidade                                          |
| ----------------------- | --------------------------------------------------- |
| `dashboard_faturamento` | Linhas de faturamento por versão e ordem original   |
| `dashboard_metas`       | Metas por versão e ordem original                   |
| `dashboard_imports`     | Histórico de arquivo, data, responsável e contagens |
| `dashboard_admins`      | Usuários Supabase autorizados a administrar         |
| `dashboard_settings`    | Ponteiro da versão ativa e opção de leitura pública |

As linhas são armazenadas como JSONB validado, preservando campos comerciais e opcionais, ausências, mês, data, metas financeiras e valores de correção. Não se impõe unicidade de linhas de faturamento: registros legítimos podem ser iguais. A agregação de metas existente continua sendo utilizada pelo parser e pelo dashboard.

RLS e privilégios bloqueiam gravação direta inclusive para administradores autenticados. A operação transacional `dashboard_publish` é invocada pelo backend com o token do usuário e verifica novamente `auth.uid()` e a tabela de administradores. O backend valida o token remotamente com `auth.getUser()`. Usuários não podem conceder permissão a si mesmos. Nenhuma chave `service_role` é utilizada ou enviada ao frontend.

Uma transação insere histórico, faturamento e metas antes de trocar o ponteiro ativo. Qualquer falha desfaz tudo. Um bloqueio de linha serializa publicações; a versão esperada impede sobrescrever uma publicação concorrente. O UUID da importação permite repetir a mesma requisição após uma resposta perdida sem duplicar dados; reuso com conteúdo diferente é rejeitado. As versões anteriores ficam preservadas. Não há exclusão automática nem interface de restauração neste PR.

A leitura pública da **base completa**, incluindo dimensões e valores detalhados, foi expressamente autorizada para este projeto. Por isso `public_read_enabled` inicia como `true`. O histórico e o e-mail do responsável ficam restritos aos administradores. A função pública expõe apenas a versão ativa, não as tabelas nem versões anteriores. Um operador autorizado pode suspender novas leituras públicas:

```sql
update public.dashboard_settings set public_read_enabled = false where singleton;
```

Isso não apaga dados já baixados por visitantes. A permissão administrativa é verificada novamente a cada publicação.

## Supabase e criação do administrador

Projeto indicado: `https://yvsuaterzpekenlyzaoa.supabase.co`. `supabase/config.toml` foi alinhado a esse identificador; isso não conecta o CLI nem aplica migrações automaticamente.

As migrações históricas não são um bootstrap seguro para esse projeto: referem-se a tabelas preexistentes e contêm `DROP TABLE`/`DROP VIEW`. **Não executar `supabase db push` de todo o histórico sem reconciliar o histórico do projeto.** Executar a nova migração isoladamente no SQL Editor do projeto indicado, após revisão, ou incorporá-la ao fluxo de migrações existente da equipe. Nenhuma migração foi aplicada ao projeto remoto por este trabalho.

1. Em Supabase Auth, criar ou convidar o administrador. Verificar seu e-mail e definir a senha pelos fluxos do Supabase. Não há criação pública de contas administrativas no dashboard.
2. No SQL Editor, um operador autorizado concede a permissão ao usuário correto:

```sql
insert into public.dashboard_admins(user_id)
select id from auth.users where lower(email) = lower('administrador@empresa.example')
on conflict (user_id) do nothing;
```

3. Confirmar que o usuário pretendido foi autorizado. O comando não cria usuários nem concede permissão quando o e-mail não existe.
4. Entrar pela seção “Gerenciamento da Base de Dados”, selecionar a base combinada ou duas planilhas (faturamento/metas), conferir a prévia e publicar permanentemente após confirmar a substituição.

Para revogar a permissão, executar `delete from public.dashboard_admins where user_id = '<uuid do usuário>'`. Esses comandos são instruções para um operador autorizado e não foram executados no banco real.

## Vercel e desenvolvimento

Configurar as variáveis no Vercel para Production e Preview, preferencialmente usando projetos Supabase separados:

| Variável                   | Valor                                                                |
| -------------------------- | -------------------------------------------------------------------- |
| `SUPABASE_URL`             | `https://yvsuaterzpekenlyzaoa.supabase.co`                           |
| `SUPABASE_PUBLISHABLE_KEY` | Chave pública `sb_publishable_...` ou chave legada `anon` do projeto |

Não utilizar `SUPABASE_SERVICE_ROLE_KEY`. O backend entrega apenas a configuração pública necessária ao SDK de login; variáveis `VITE_*` não são obrigatórias. Para compatibilidade, aceita `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` quando as variáveis acima estiverem ausentes. Uma chave administrativa colocada por engano no campo público é rejeitada sem exposição.

`vercel.json` fixa Bun 1.4.3 por `npx`, instala com lockfile congelado e executa `build:vercel`. Também desativa deployment automático da branch deste PR (`codex/supabase-base-compartilhada`), respeitando a instrução de não publicar automaticamente. O build gera `.vercel/output` e uma função Node.js 24; escolher Node.js 24 no Vercel. Não configurar `dist` como saída estática: as operações administrativas dependem da função backend. Registrar a URL do site em Supabase Auth > URL Configuration. Login por senha não exige callback; convites e recuperação de senha usam os fluxos configurados no Supabase.

Localmente, copiar `.env.example` para `.env.local`, preencher a chave pública e usar Bun 1.4.3:

```bash
bun install --frozen-lockfile
bun run dev
bun test
bun run test:sql
bun run build:vercel
```

Versões anteriores de Bun falharam na leitura dos peers do lockfile atual. Se a rede restringir os espelhos `europe-west1-npm.pkg.dev`/`europe-west4-npm.pkg.dev`, usar o procedimento de cache da configuração do ambiente em nuvem, que mantém versões e checksums, ou autorizar os destinos. Nunca desativar verificação TLS ou de integridade.

No ambiente em nuvem foram salvos os requisitos das duas variáveis e os destinos Supabase, IBGE e API GitHub no rascunho. Isso não cria uma chave, configura o Vercel, aplica migrações ou publica o ambiente. O mapa continua consultando `servicodados.ibge.gov.br`.

## Testes, riscos e limitações

- `bun test`: regressões comerciais existentes, importação combinada/separada, preservação de dados/metas, validação de payload, leitura pública, sessão inválida, autorização e conflito.
- `bun run test:sql`: PostgreSQL 17 descartável sem rede; aplica só a migração nova e verifica RLS, rollback, histórico, idempotência, concorrência e leitura em conexão nova. Nunca aceita URL de banco remoto.
- `bash tests/run-e2e.sh`: requer Docker, Bun, Node, Playwright e Chromium, com portas 3001/54329 livres. Cria banco descartável, simula os endpoints Auth/PostgREST com dados e credenciais fictícios e usa as funções SQL reais. Testa visitantes, cache antigo, prévia, login, bloqueio de não administrador, publicação, recarga, outro visitante e responsividade. Pode selecionar Chromium por `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Auth simulado não substitui o aceite com o Supabase Auth real.
- `node tests/visual.mjs`: compara a versão atual em porta 3000 com uma cópia de referência anterior em porta 3002, usando a mesma base embarcada, em 1440/390 pixels. Confere textos, dimensões e capturas dos cards, excluindo o gerenciamento que recebeu novos controles. A tolerância de 0,1% cobre rasterização de bordas/sombras. O fetch IBGE é interrompido igualmente nos dois lados para isolar o serviço externo.

Na cópia de referência, usar um `vite.cacheDir` separado (por exemplo, `.vite-cache` dentro dessa cópia); compartilhar o cache de dependências entre dois servidores Vite com configurações distintas causa falhas transitórias de carregamento do cliente. Não executar builds enquanto faz a comparação visual. A referência usada na validação foi um arquivo de fontes do commit `f8fc30a`, sem criar Git worktree.

Resultados nesta implementação: 38 testes automatizados passaram; TypeScript passou; os testes SQL de segurança, atomicidade e concorrência passaram; o fluxo E2E passou; os 21 cards existentes passaram na comparação visual em 1440 e 390 pixels. O build Vercel gerou uma função Node.js 24. O endpoint IBGE retornou HTTP 200 com 27 UFs. As funções novas também passaram no lint específico; o lint geral permanece com pendências preexistentes.

Publicações aceitam até 25.000 linhas de faturamento, 25.000 metas e aproximadamente 3 MB de JSON, abaixo do limite de requisição de função do Vercel. Cada Excel deve ter no máximo 10 MB. O banco também impõe limites sobre sua representação JSONB. Bases maiores exigem upload em lotes/staging, fora deste PR. A leitura retorna uma versão inteira numa RPC, sem truncamento por paginação; acompanhar latência e tamanho da base. Versões históricas acumulam armazenamento; a equipe deve definir a retenção.

Nenhum dado real foi gravado, apagado ou substituído nos testes. Sem chave pública e migração aplicada, não é possível afirmar que o Supabase remoto está pronto. O lint geral já tinha 799 erros de formatação e 26 avisos; não foi realizada uma reformatação geral do dashboard.

## Publicação e aceite

Após revisar o PR, aplicar a migração nova ao projeto correto, provisionar o administrador e preencher as variáveis no Vercel. Só então autorizar o deployment. Não houve merge nem publicação automática.

Validar primeiro em Preview: abrir sem login e conferir data/arquivo, indicadores e base ativa; confirmar o bloqueio para usuário sem permissão; publicar dados fictícios com administrador **em projeto de teste**. Conferir FY25/FY26, quarters, meses, multi-UF, UF Hospital/Cliente, filtros combinados, rankings, drill-down, Excel exportado e reconciliação. Recarregar e abrir outro navegador deve apresentar a mesma versão. Falhas e publicações concorrentes devem preservar uma versão consistente. Em produção, não testar substituições com dados fictícios sem autorização específica.
