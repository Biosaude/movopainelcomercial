-- Run exclusively in the separately verified synthetic Supabase project.
-- Provision the commercial_preview_reader login through the approved secret workflow first.
BEGIN;
-- Keep legacy browser roles from accessing protected tables and views directly.
REVOKE SELECT ON TABLE public.dashboard_imports, public.dashboard_faturamento,
  public.dashboard_metas, public.dashboard_settings, public.dashboard_uploads,
  public.dashboard_upload_chunks
  FROM PUBLIC, anon, authenticated, commercial_preview_reader;

-- Fresh synthetic projects can start with only the shared-version schema.
DO $legacy$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['faturamento_comercial', 'metas_representante',
    'vw_dashboard_representante', 'vw_metas_representante_validacao']
  LOOP
    IF to_regclass('public.' || relation) IS NOT NULL THEN
      EXECUTE format('REVOKE SELECT ON TABLE public.%I FROM PUBLIC, anon, authenticated, commercial_preview_reader', relation);
    END IF;
  END LOOP;
END $legacy$;

-- The backend calls this after independently checking Supabase administrator membership
-- and the Entra user's individual Central entitlement.
CREATE FUNCTION public.dashboard_preview_read_history() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.published_at DESC), '[]'::jsonb)
  FROM (
    SELECT id, published_at, file_name, revenue_count, target_count, created_by_label
    FROM public.dashboard_imports ORDER BY published_at DESC LIMIT 50
  ) i;
$$;
REVOKE EXECUTE ON FUNCTION public.dashboard_read_manifest(),
  public.dashboard_read_snapshot(), public.dashboard_read_page(uuid,text,integer),
  public.dashboard_preview_read_history()
  FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO commercial_preview_reader;
GRANT EXECUTE ON FUNCTION public.dashboard_read_manifest(),
  public.dashboard_read_snapshot(), public.dashboard_read_page(uuid,text,integer),
  public.dashboard_preview_read_history()
  TO commercial_preview_reader;
NOTIFY pgrst, 'reload schema';
COMMIT;
