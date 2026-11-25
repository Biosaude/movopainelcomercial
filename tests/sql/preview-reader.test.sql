DO $assert$
BEGIN
  IF has_function_privilege('anon', 'public.dashboard_read_snapshot()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.dashboard_read_manifest()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.dashboard_read_page(uuid,text,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.dashboard_preview_read_history()', 'EXECUTE')
     OR has_table_privilege('anon', 'public.vw_dashboard_representante', 'SELECT')
     OR has_table_privilege('authenticated', 'public.dashboard_faturamento', 'SELECT')
     OR has_table_privilege('commercial_preview_reader', 'public.dashboard_faturamento', 'SELECT')
     OR has_function_privilege('commercial_preview_reader', 'public.dashboard_publish(uuid,uuid,text,jsonb,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.dashboard_publish(uuid,uuid,text,jsonb,jsonb)', 'EXECUTE')
  THEN RAISE EXCEPTION 'unexpected privileges in isolated Preview'; END IF;
END $assert$;
SET ROLE commercial_preview_reader;
DO $read$
BEGIN
  IF NOT (public.dashboard_read_manifest()->>'access')::boolean
     OR public.dashboard_preview_read_history() IS NULL
  THEN RAISE EXCEPTION 'dedicated reader cannot load the dashboard'; END IF;
END $read$;
RESET ROLE;
