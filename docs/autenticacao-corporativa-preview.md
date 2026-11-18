# Acesso corporativo no Preview do Comercial

O modo `COMMERCIAL_AUTH_MODE=preview` protege as chamadas de leitura do TanStack Start. O modo público continua sendo o padrão e a aplicação ignora essa ativação se `VERCEL_ENV=production`. O layout e os cálculos continuam no Comercial. As permissões de publicação continuam no fluxo Supabase Auth e em `dashboard_admins`.

## Configuração isolada

| Configuração | Uso |
|---|---|
| `COMMERCIAL_PREVIEW_ORIGIN` | Origem HTTPS exata do Preview. Registre `/api/corporate-auth/callback` nessa origem no aplicativo Web do Entra. HTTP de loopback é aceito para desenvolvimento local. |
| `COMMERCIAL_ENTRA_TENANT_ID`, `COMMERCIAL_ENTRA_CLIENT_ID`, `COMMERCIAL_ENTRA_CLIENT_SECRET` | Tenant único e aplicativo Web dedicado ao Comercial. |
| `COMMERCIAL_SESSION_STORE_URL`, `COMMERCIAL_SESSION_STORE_TOKEN` | Redis REST isolado, compatível com comandos JSON `SET … EX … NX`, `GET`, `GETDEL` e `DEL`. Use endpoint HTTPS e credencial dedicada. |
| `CENTRAL_BI_ENTITLEMENT_URL` | URL HTTPS exata do endpoint de homologação da Central, com o caminho `/api/internal/commercial-entitlement`. |
| `CENTRAL_BI_ASSERTION_KEY_ID`, `CENTRAL_BI_ASSERTION_PRIVATE_KEY` | Identificador da chave e chave privada Ed25519 PEM do Comercial. A Central recebe somente a chave pública. |
| `COMMERCIAL_PREVIEW_READER_DATABASE_URL` | Conexão server-only do papel `commercial_preview_reader` no Supabase de Preview, TLS `verify-full`, porta 5432, endpoint direto ou session pooler vinculado ao mesmo projeto. |
| `COMMERCIAL_PREVIEW_SUPABASE_URL`, `COMMERCIAL_PREVIEW_SUPABASE_PUBLISHABLE_KEY` | Projeto Supabase isolado com dados sintéticos. O Preview corporativo rejeita o projeto original e não usa as variáveis públicas como fallback. |

Guarde as credenciais apenas no servidor de homologação. O cookie de sessão é opaco, restrito ao host, `HttpOnly`, `Secure` em HTTPS e `SameSite=Lax`. A tentativa OIDC expira em 10 minutos e é consumida uma vez. A sessão do Comercial dura até uma hora e pode ser revogada pelo `POST /api/corporate-auth/logout` da própria origem. O logout da Central e o do Comercial são independentes.

## Contrato com a Central

O Comercial envia `POST` sem corpo, com uma asserção JWT `Authorization: Bearer` assinada em EdDSA. O cabeçalho contém o `kid` configurado. Na asserção, `iss` e `sub` são `movopainelcomercial`, `aud` é a URL exata do endpoint e a validade é de 30 segundos. Inclui `iat`, `exp`, `jti`, `tid`, `oid`, `dashboard=painel-comercial-r1` e `permission=dashboard:read`. O navegador não fornece os identificadores usados nessa decisão.

A interface receptora da Central verifica assinatura, chave, emissor, audiência, validade e uso único de `jti`, restringir a credencial ao módulo Comercial e consultar a conta habilitada, o módulo ativo e a concessão individual. O contrato responde HTTP 200 com `{ "allowed": true }` ou `{ "allowed": false }`. Falha de serviço ou resposta inválida bloqueia a leitura. O Comercial consulta a concessão no login e a cada chamada de estado ou paginação. O backend preserva a estrutura dos dados e desabilita a base embarcada no Preview corporativo.

## Limite desta etapa

O site público e as permissões do Supabase continuam atuais. O Preview corporativo usa o papel PostgreSQL dedicado e verifica os privilégios das RPCs, views e tabelas antes de ler. A instalação das ACLs de `supabase/operations/commercial-preview-reader.sql` exige aprovação e um Supabase isolado com dados sintéticos. O modo de leitura das RPCs legadas deve permitir leitura pelo papel dedicado. As ACLs barram a execução por `anon` e `authenticated`, inclusive quando esse modo de leitura está habilitado. A homologação real depende do endpoint da Central, do registro Entra e de Redis e Supabase isolados. Os testes locais usam identidades, chaves e serviços simulados. Para retirar esta fase de um Preview de trabalho, remova a ativação desse Preview.

## Testes locais

Execute `bun test` para as regressões do painel e os cenários OIDC e de autorização. Execute `bun run build:vercel` e depois `node tests/corporate-preview-smoke.mjs` para testar a função Vercel compilada, incluindo SSR, chamadas diretas de estado e paginação, revogação e compatibilidade com o modo público. O teste intercepta todas as chamadas aos serviços externos e usa apenas respostas sintéticas.
