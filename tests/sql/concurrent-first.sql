\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
-- Hold the same row lock as publication, giving the contender time to start.
SELECT public.dashboard_publish('10000000-0000-4000-8000-000000000002',
 '10000000-0000-4000-8000-000000000001', 'fictional-v2.xlsx',
 '[{"gr":"TEST","rep":"REP","uf":"PA","marca":"MARCA","topico":"TEST","tipo":"TEST","periodo":"Q3 2026","valor":456}]',
 '[{"gr":"TEST","rep":"REP","uf":"PA","marca":"MARCA","topico":"TEST","tipo":"TEST","periodo":"Q3 2026","meta":600,"metaFinanceira":540}]');
\echo LOCK_ACQUIRED
SELECT pg_sleep(2);
COMMIT;
