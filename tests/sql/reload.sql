\set ON_ERROR_STOP on
SET ROLE anon;
DO $$ DECLARE s jsonb; BEGIN
  s := public.dashboard_read_snapshot()->'snapshot';
  IF s->'import'->>'id' <> '10000000-0000-4000-8000-000000000002' THEN RAISE EXCEPTION 'Fresh visitor did not load latest version'; END IF;
  IF (s->'faturamento'->0->>'valor')::numeric <> 456 OR (s->'metas'->0->>'metaFinanceira')::numeric <> 540 THEN RAISE EXCEPTION 'Mixed versions after concurrent write'; END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.dashboard_imports) <> 2 THEN RAISE EXCEPTION 'Concurrent writer created extra history'; END IF;
  IF (SELECT count(*) FROM public.dashboard_faturamento WHERE import_id = '10000000-0000-4000-8000-000000000001') <> 1 THEN RAISE EXCEPTION 'Historical revenue lost'; END IF;
END $$;
\echo 'Concurrent publication and fresh-connection reload assertions passed.'
