\set ON_ERROR_STOP on
-- Every record below is fictitious. Never run this against a real project.
INSERT INTO public.dashboard_admins(user_id) VALUES ('00000000-0000-4000-8000-000000000001');
SET ROLE anon;
DO $$ BEGIN
  IF public.dashboard_read_snapshot()->'snapshot' <> 'null'::jsonb THEN RAISE EXCEPTION 'Expected unpublished base'; END IF;
  BEGIN
    PERFORM public.dashboard_publish(gen_random_uuid(), NULL, 'blocked.xlsx', '[]', '[]');
    RAISE EXCEPTION 'Anonymous write allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM * FROM public.dashboard_faturamento;
    RAISE EXCEPTION 'Direct anonymous table read allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002';
DO $$ BEGIN
  IF public.dashboard_is_admin() THEN RAISE EXCEPTION 'Non-admin accepted'; END IF;
  IF (SELECT count(*) FROM public.dashboard_imports) <> 0 THEN RAISE EXCEPTION 'History leaked'; END IF;
  BEGIN
    PERFORM public.dashboard_publish(gen_random_uuid(), NULL, 'blocked.xlsx', '[]', '[]');
    RAISE EXCEPTION 'Non-admin write allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO public.dashboard_admins(user_id) VALUES (auth.uid());
    RAISE EXCEPTION 'Self promotion allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SET request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
SELECT public.dashboard_publish(
  '10000000-0000-4000-8000-000000000001', NULL, 'fictional-v1.xlsx',
  '[{"gr":"TEST","rep":"REP","uf":"AP","marca":"MARCA","topico":"TEST","tipo":"TEST","periodo":"Q3 2026","mes":"08","ufHospital":"AP","cliente":"Cliente fictício","valor":123.45}]',
  '[{"gr":"TEST","rep":"REP","uf":"AP","marca":"MARCA","topico":"TEST","tipo":"TEST","periodo":"Q3 2026","meta":300,"metaFinanceira":270}]'
);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.dashboard_imports) <> 1 THEN RAISE EXCEPTION 'Missing admin history'; END IF;
  BEGIN
    INSERT INTO public.dashboard_metas(import_id,row_index,data) VALUES ('10000000-0000-4000-8000-000000000001', 2, '{}');
    RAISE EXCEPTION 'Direct admin table write allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.dashboard_publish('10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001', 'invalid-v2.xlsx',
      '[{"gr":"TEST","rep":"REP","uf":"PA","marca":"MARCA","topico":"TEST","tipo":"TEST","periodo":"Q3 2026","valor":999}]', '[{"meta":"invalid"}]');
    RAISE EXCEPTION 'Invalid targets accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  IF (SELECT count(*) FROM public.dashboard_imports) <> 1 THEN RAISE EXCEPTION 'Partial import persisted'; END IF;
  IF (SELECT count(*) FROM public.dashboard_faturamento) <> 1 THEN RAISE EXCEPTION 'Partial revenue persisted'; END IF;
  IF public.dashboard_read_snapshot()->'snapshot'->'import'->>'id' <> '10000000-0000-4000-8000-000000000001' THEN RAISE EXCEPTION 'Pointer changed after failure'; END IF;
END $$;
-- Idempotent retry of the committed request.
SELECT public.dashboard_publish(
  '10000000-0000-4000-8000-000000000001', NULL, 'fictional-v1.xlsx',
  '[{"gr":"TEST","rep":"REP","uf":"AP","marca":"MARCA","topico":"TEST","tipo":"TEST","periodo":"Q3 2026","mes":"08","ufHospital":"AP","cliente":"Cliente fictício","valor":123.45}]',
  '[{"gr":"TEST","rep":"REP","uf":"AP","marca":"MARCA","topico":"TEST","tipo":"TEST","periodo":"Q3 2026","meta":300,"metaFinanceira":270}]'
);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.dashboard_imports) <> 1 THEN RAISE EXCEPTION 'Duplicate import created'; END IF;
  BEGIN
    PERFORM public.dashboard_publish('10000000-0000-4000-8000-000000000001', NULL, 'altered.xlsx',
      '[{"gr":"TEST","rep":"REP","uf":"AP","marca":"MARCA","topico":"TEST","tipo":"TEST","periodo":"Q3 2026","valor":123.45}]', '[]');
    RAISE EXCEPTION 'Replay with altered payload accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    PERFORM public.dashboard_publish('10000000-0000-4000-8000-000000000003', NULL, 'stale.xlsx',
      '[{"gr":"TEST","rep":"REP","uf":"AP","marca":"MARCA","topico":"TEST","tipo":"TEST","periodo":"Q3 2026","valor":123.45}]', '[]');
    RAISE EXCEPTION 'Stale base overwritten';
  EXCEPTION WHEN serialization_failure THEN NULL; END;
END $$;
RESET ROLE;
SET request.jwt.claim.sub = '';
SET ROLE anon;
DO $$ DECLARE s jsonb; BEGIN
  s := public.dashboard_read_snapshot()->'snapshot';
  IF (s->'faturamento'->0->>'valor')::numeric <> 123.45 THEN RAISE EXCEPTION 'Revenue changed'; END IF;
  IF (s->'metas'->0->>'metaFinanceira')::numeric <> 270 THEN RAISE EXCEPTION 'Target changed'; END IF;
  IF s->'import' ? 'created_by_label' THEN RAISE EXCEPTION 'Uploader email leaked to public'; END IF;
END $$;
RESET ROLE;
UPDATE public.dashboard_settings SET public_read_enabled = false;
SET ROLE anon;
DO $$ BEGIN
  IF (public.dashboard_read_snapshot()->>'access')::boolean THEN RAISE EXCEPTION 'Revoked public access still allowed'; END IF;
END $$;
RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  IF NOT (public.dashboard_read_snapshot()->>'access')::boolean THEN RAISE EXCEPTION 'Admin locked out'; END IF;
END $$;
RESET ROLE;
UPDATE public.dashboard_settings SET public_read_enabled = true;
\echo 'SQL assertions passed: access, RLS, atomic rollback, idempotency, history, stale version, exact values.'
