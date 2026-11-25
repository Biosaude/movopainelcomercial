-- Apply only to the verified Commercial database after reviewing existing grants.
-- Use the approved credential workflow for both login roles before running this operation.
BEGIN;

DO $roles$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['commercial_runtime_reader', 'commercial_runtime_publisher']
  LOOP
    IF NOT EXISTS (
      SELECT FROM pg_roles r
      WHERE r.rolname = name AND r.rolcanlogin
        AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
        AND NOT EXISTS (SELECT FROM pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid)
        AND NOT has_schema_privilege(r.rolname, 'public', 'CREATE')
    ) THEN RAISE EXCEPTION 'Papel de execução inválido: %', name; END IF;
  END LOOP;
END
$roles$;

REVOKE ALL ON TABLE public.dashboard_imports, public.dashboard_faturamento,
  public.dashboard_metas, public.dashboard_settings, public.dashboard_uploads,
  public.dashboard_upload_chunks
  FROM PUBLIC, anon, authenticated, commercial_runtime_reader, commercial_runtime_publisher;

DO $legacy$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['faturamento_comercial', 'metas_representante', 'metas_representante_nova',
    'vw_dashboard_representante', 'vw_metas_representante_validacao']
  LOOP
    IF to_regclass('public.' || relation) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, commercial_runtime_reader, commercial_runtime_publisher', relation);
    END IF;
  END LOOP;
END
$legacy$;

CREATE OR REPLACE FUNCTION public.dashboard_preview_read_history() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.published_at DESC), '[]'::jsonb)
  FROM (
    SELECT id, published_at, file_name, revenue_count, target_count, created_by_label
    FROM public.dashboard_imports ORDER BY published_at DESC LIMIT 50
  ) i;
$$;

REVOKE EXECUTE ON FUNCTION public.dashboard_read_manifest(), public.dashboard_read_snapshot(),
  public.dashboard_read_page(uuid,text,integer), public.dashboard_preview_read_history()
  FROM PUBLIC, anon, authenticated, commercial_runtime_publisher;
GRANT USAGE ON SCHEMA public TO commercial_runtime_reader, commercial_runtime_publisher;
GRANT EXECUTE ON FUNCTION public.dashboard_read_manifest(), public.dashboard_read_snapshot(),
  public.dashboard_read_page(uuid,text,integer), public.dashboard_preview_read_history()
  TO commercial_runtime_reader;

-- Preserve public_read_enabled. Allow the dedicated login to read after the server's corporate check.
-- Abort on a definition other than the reviewed migration or its secured form.
DO $reader$
DECLARE
  target regprocedure;
  original text;
  marker text;
  secured text;
BEGIN
  FOR target, marker IN SELECT * FROM (VALUES
    ('public.dashboard_read_manifest()'::regprocedure, 'COALESCE(can_read,false) OR is_admin'),
    ('public.dashboard_read_snapshot()'::regprocedure, 'can_read OR is_admin'),
    ('public.dashboard_read_page(uuid,text,integer)'::regprocedure, 'COALESCE(can_read,false) OR public.dashboard_is_admin()')
  ) AS rules(target, marker)
  LOOP
    original := pg_get_functiondef(target);
    secured := marker || ' OR session_user = ''commercial_runtime_reader''';
    IF strpos(original, secured) > 0 THEN CONTINUE; END IF;
    IF length(original) - length(replace(original, marker, '')) <> length(marker) THEN
      RAISE EXCEPTION 'Definição inesperada: %', target;
    END IF;
    EXECUTE replace(original, marker, secured);
  END LOOP;
END
$reader$;

REVOKE EXECUTE ON FUNCTION public.dashboard_publish(uuid,uuid,text,jsonb,jsonb),
  public.dashboard_upload_begin(uuid,uuid,text,integer,integer,jsonb),
  public.dashboard_upload_chunk(uuid,integer,text), public.dashboard_upload_commit(uuid)
  FROM PUBLIC, anon, authenticated, commercial_runtime_reader;
GRANT EXECUTE ON FUNCTION public.dashboard_publish(uuid,uuid,text,jsonb,jsonb),
  public.dashboard_upload_begin(uuid,uuid,text,integer,integer,jsonb),
  public.dashboard_upload_chunk(uuid,integer,text), public.dashboard_upload_commit(uuid)
  TO commercial_runtime_publisher;

DO $effective_acl$
BEGIN
  IF EXISTS (
    SELECT FROM unnest(ARRAY['anon','authenticated', 'commercial_runtime_publisher']) AS roles(name)
    CROSS JOIN unnest(ARRAY['public.dashboard_read_manifest()', 'public.dashboard_read_snapshot()',
      'public.dashboard_read_page(uuid,text,integer)', 'public.dashboard_preview_read_history()']) AS functions(signature)
    WHERE has_function_privilege(roles.name, functions.signature, 'EXECUTE')
  ) OR EXISTS (
    SELECT FROM unnest(ARRAY['anon','authenticated', 'commercial_runtime_reader']) AS roles(name)
    CROSS JOIN unnest(ARRAY['public.dashboard_publish(uuid,uuid,text,jsonb,jsonb)',
      'public.dashboard_upload_begin(uuid,uuid,text,integer,integer,jsonb)',
      'public.dashboard_upload_chunk(uuid,integer,text)', 'public.dashboard_upload_commit(uuid)']) AS functions(signature)
    WHERE has_function_privilege(roles.name, functions.signature, 'EXECUTE')
  ) OR EXISTS (
    SELECT FROM unnest(ARRAY['anon','authenticated','commercial_runtime_reader','commercial_runtime_publisher']) AS roles(name)
    CROSS JOIN unnest(ARRAY['dashboard_imports','dashboard_faturamento','dashboard_metas','dashboard_settings',
      'dashboard_uploads','dashboard_upload_chunks','faturamento_comercial','metas_representante','metas_representante_nova',
      'vw_dashboard_representante','vw_metas_representante_validacao']) AS rel(name)
    WHERE has_any_column_privilege(roles.name, to_regclass('public.' || rel.name), 'SELECT,INSERT,UPDATE,REFERENCES')
       OR has_table_privilege(roles.name, to_regclass('public.' || rel.name), 'DELETE,TRUNCATE,TRIGGER')
  ) THEN RAISE EXCEPTION 'Acesso indireto ou privilégio de coluna ainda ativo'; END IF;
END
$effective_acl$;

NOTIFY pgrst, 'reload schema';
COMMIT;
