-- Additive migration: never changes or deletes the legacy commercial tables.
CREATE TABLE public.dashboard_admins (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.dashboard_imports (
  id uuid PRIMARY KEY,
  published_at timestamptz NOT NULL DEFAULT now(),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_by_label text NOT NULL,
  revenue_count integer NOT NULL CHECK (revenue_count BETWEEN 1 AND 25000),
  target_count integer NOT NULL CHECK (target_count BETWEEN 0 AND 25000)
);

CREATE FUNCTION public.dashboard_valid_row(p_data jsonb, p_is_target boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; allowed text[];
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['gr','rep','uf','marca','topico','tipo','periodo'] LOOP
    IF jsonb_typeof(p_data->k) IS DISTINCT FROM 'string' OR length(p_data->>k) > 1000 THEN RETURN false; END IF;
  END LOOP;
  IF (p_data->>'periodo') !~ '^Q[1-4] 20[0-9]{2}$' THEN RETURN false; END IF;
  IF length(p_data->>CASE WHEN p_is_target THEN 'rep' ELSE 'gr' END) = 0 THEN RETURN false; END IF;
  IF jsonb_typeof(p_data->CASE WHEN p_is_target THEN 'meta' ELSE 'valor' END) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  IF p_is_target AND p_data ? 'metaFinanceira' AND jsonb_typeof(p_data->'metaFinanceira') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  allowed := ARRAY['gr','rep','uf','marca','topico','tipo','periodo','mes','cliente','medico','assessor','ufCliente','ufHospital'];
  IF p_is_target THEN allowed := allowed || ARRAY['meta','metaFinanceira'];
  ELSE allowed := allowed || ARRAY['valor','data','hospital']; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF NOT k = ANY(allowed) THEN RETURN false; END IF;
    IF k NOT IN ('valor','meta','metaFinanceira') AND (jsonb_typeof(p_data->k) IS DISTINCT FROM 'string' OR length(p_data->>k) > 1000) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE TABLE public.dashboard_faturamento (
  import_id uuid NOT NULL REFERENCES public.dashboard_imports(id),
  row_index integer NOT NULL CHECK (row_index > 0),
  data jsonb NOT NULL CHECK (public.dashboard_valid_row(data, false)),
  PRIMARY KEY (import_id, row_index)
);
CREATE TABLE public.dashboard_metas (
  import_id uuid NOT NULL REFERENCES public.dashboard_imports(id),
  row_index integer NOT NULL CHECK (row_index > 0),
  data jsonb NOT NULL CHECK (public.dashboard_valid_row(data, true)),
  PRIMARY KEY (import_id, row_index)
);
CREATE TABLE public.dashboard_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active_import_id uuid REFERENCES public.dashboard_imports(id),
  -- Full public access explicitly authorized for this dashboard. Can be revoked here.
  public_read_enabled boolean NOT NULL DEFAULT true
);
INSERT INTO public.dashboard_settings(singleton) VALUES (true);

ALTER TABLE public.dashboard_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_faturamento ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_metas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_settings ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.dashboard_is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS(SELECT 1 FROM public.dashboard_admins WHERE user_id = auth.uid());
$$;
REVOKE ALL ON FUNCTION public.dashboard_is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dashboard_is_admin() TO anon, authenticated;
REVOKE ALL ON public.dashboard_admins, public.dashboard_imports, public.dashboard_faturamento,
  public.dashboard_metas, public.dashboard_settings FROM anon, authenticated;
GRANT SELECT ON public.dashboard_admins, public.dashboard_imports, public.dashboard_faturamento,
  public.dashboard_metas TO authenticated;
GRANT ALL ON public.dashboard_admins, public.dashboard_imports, public.dashboard_faturamento,
  public.dashboard_metas, public.dashboard_settings TO service_role;
CREATE POLICY dashboard_admin_own_permission ON public.dashboard_admins FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY dashboard_import_admin_read ON public.dashboard_imports FOR SELECT TO authenticated USING (public.dashboard_is_admin());
CREATE POLICY dashboard_revenue_admin_read ON public.dashboard_faturamento FOR SELECT TO authenticated USING (public.dashboard_is_admin());
CREATE POLICY dashboard_targets_admin_read ON public.dashboard_metas FOR SELECT TO authenticated USING (public.dashboard_is_admin());

-- One immutable version per response, unaffected by pagination or concurrent publishes.
CREATE FUNCTION public.dashboard_read_snapshot() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE version_id uuid; is_admin boolean; can_read boolean; meta jsonb;
BEGIN
  is_admin := public.dashboard_is_admin();
  SELECT active_import_id, public_read_enabled INTO version_id, can_read FROM public.dashboard_settings WHERE singleton;
  IF NOT (can_read OR is_admin) THEN
    RETURN jsonb_build_object('access', false, 'isAdmin', is_admin, 'snapshot', NULL);
  END IF;
  IF version_id IS NULL THEN RETURN jsonb_build_object('access', true, 'isAdmin', is_admin, 'snapshot', NULL); END IF;
  SELECT to_jsonb(i) - 'created_by' - 'created_by_label' INTO meta FROM public.dashboard_imports i WHERE id = version_id;
  RETURN jsonb_build_object('access', true, 'isAdmin', is_admin, 'snapshot', jsonb_build_object(
    'import', meta,
    'faturamento', (SELECT jsonb_agg(data ORDER BY row_index) FROM public.dashboard_faturamento WHERE import_id = version_id),
    'metas', COALESCE((SELECT jsonb_agg(data ORDER BY row_index) FROM public.dashboard_metas WHERE import_id = version_id), '[]'::jsonb)
  ));
END $$;
REVOKE ALL ON FUNCTION public.dashboard_read_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dashboard_read_snapshot() TO anon, authenticated;

-- Called by the authenticated backend. Auth and admin membership are checked again
-- in PostgreSQL, including calls that bypass the UI or invoke the RPC directly.
CREATE FUNCTION public.dashboard_publish(
  p_request_id uuid, p_expected_version uuid, p_file_name text,
  p_faturamento jsonb, p_metas jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE previous_id uuid; actor uuid; actor_label text; existing public.dashboard_imports; stored_revenue jsonb; stored_targets jsonb;
BEGIN
  actor := auth.uid();
  IF actor IS NULL OR NOT public.dashboard_is_admin() THEN RAISE EXCEPTION 'Administrador obrigatório' USING ERRCODE = '42501'; END IF;
  IF jsonb_typeof(p_faturamento) IS DISTINCT FROM 'array' OR jsonb_typeof(p_metas) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Estrutura de base inválida' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_faturamento) NOT BETWEEN 1 AND 25000 OR jsonb_array_length(p_metas) > 25000
     OR octet_length(p_faturamento::text) + octet_length(p_metas::text) > 3000000 THEN
    RAISE EXCEPTION 'Limite da base excedido' USING ERRCODE = '22023';
  END IF;
  IF p_request_id IS NULL OR p_file_name IS NULL OR length(btrim(p_file_name)) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'Identificação inválida' USING ERRCODE = '22023';
  END IF;
  SELECT active_import_id INTO previous_id FROM public.dashboard_settings WHERE singleton FOR UPDATE;
  SELECT * INTO existing FROM public.dashboard_imports WHERE id = p_request_id;
  IF FOUND THEN
    SELECT jsonb_agg(data ORDER BY row_index) INTO stored_revenue FROM public.dashboard_faturamento WHERE import_id = p_request_id;
    SELECT COALESCE(jsonb_agg(data ORDER BY row_index), '[]'::jsonb) INTO stored_targets FROM public.dashboard_metas WHERE import_id = p_request_id;
    IF existing.created_by <> actor OR existing.file_name <> btrim(p_file_name)
       OR stored_revenue <> p_faturamento OR stored_targets <> p_metas THEN
      RAISE EXCEPTION 'Identificador de publicação já utilizado' USING ERRCODE = '23505';
    END IF;
    RETURN existing.id;
  END IF;
  IF previous_id IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'A base foi atualizada por outro administrador. Recarregue antes de publicar.' USING ERRCODE = '40001';
  END IF;
  SELECT COALESCE(email, actor::text) INTO actor_label FROM auth.users WHERE id = actor;
  INSERT INTO public.dashboard_imports(id, file_name, created_by, created_by_label, revenue_count, target_count)
  VALUES (p_request_id, btrim(p_file_name), actor, actor_label, jsonb_array_length(p_faturamento), jsonb_array_length(p_metas));
  INSERT INTO public.dashboard_faturamento(import_id, row_index, data)
  SELECT p_request_id, ordinal::integer, value FROM jsonb_array_elements(p_faturamento) WITH ORDINALITY AS rows(value, ordinal);
  INSERT INTO public.dashboard_metas(import_id, row_index, data)
  SELECT p_request_id, ordinal::integer, value FROM jsonb_array_elements(p_metas) WITH ORDINALITY AS rows(value, ordinal);
  UPDATE public.dashboard_settings SET active_import_id = p_request_id WHERE singleton;
  RETURN p_request_id;
END $$;
REVOKE ALL ON FUNCTION public.dashboard_publish(uuid, uuid, text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dashboard_publish(uuid, uuid, text, jsonb, jsonb) TO authenticated;
