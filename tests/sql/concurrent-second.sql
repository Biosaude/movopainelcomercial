\set ON_ERROR_STOP on
\set VERBOSITY verbose
SET ROLE authenticated;
SET request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
SELECT public.dashboard_publish('10000000-0000-4000-8000-000000000003',
 '10000000-0000-4000-8000-000000000001', 'fictional-stale.xlsx',
 '[{"gr":"TEST","rep":"REP","uf":"AP","marca":"MARCA","topico":"TEST","tipo":"TEST","periodo":"Q3 2026","valor":999}]', '[]');
