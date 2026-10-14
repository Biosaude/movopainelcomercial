-- Additional migration: the executed 20261014130000 migration stays unchanged.
-- No existing table, row, function or active version is replaced by this script.
CREATE TABLE public.dashboard_uploads (
  id uuid PRIMARY KEY,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  expected_version uuid,
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  revenue_count integer NOT NULL CHECK (revenue_count BETWEEN 1 AND 25000),
  target_count integer NOT NULL CHECK (target_count BETWEEN 0 AND 25000),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  committed_at timestamptz
);
CREATE TABLE public.dashboard_upload_chunks (
  upload_id uuid NOT NULL REFERENCES public.dashboard_uploads(id),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  rows jsonb NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  byte_bound integer NOT NULL CHECK (byte_bound > 0),
  PRIMARY KEY (upload_id, chunk_index)
);
ALTER TABLE public.dashboard_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_upload_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dashboard_uploads, public.dashboard_upload_chunks FROM anon, authenticated;
GRANT SELECT ON public.dashboard_uploads, public.dashboard_upload_chunks TO authenticated;
GRANT ALL ON public.dashboard_uploads, public.dashboard_upload_chunks TO service_role;
CREATE POLICY dashboard_upload_owner_read ON public.dashboard_uploads FOR SELECT TO authenticated
  USING (created_by = auth.uid() AND public.dashboard_is_admin());
CREATE POLICY dashboard_chunk_owner_read ON public.dashboard_upload_chunks FOR SELECT TO authenticated
  USING (public.dashboard_is_admin() AND EXISTS (
    SELECT 1 FROM public.dashboard_uploads u WHERE u.id = upload_id AND u.created_by = auth.uid()
  ));

CREATE FUNCTION public.dashboard_upload_begin(
  p_request_id uuid, p_expected_version uuid, p_file_name text,
  p_revenue_count integer, p_target_count integer, p_plan jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := auth.uid(); item jsonb; offset_f integer := 0; offset_m integer := 0; n integer; u public.dashboard_uploads;
BEGIN
  IF actor IS NULL OR NOT public.dashboard_is_admin() THEN RAISE EXCEPTION 'Administrador obrigatório' USING ERRCODE = '42501'; END IF;
  IF p_request_id IS NULL OR p_file_name IS NULL OR length(btrim(p_file_name)) NOT BETWEEN 1 AND 255
     OR p_revenue_count IS NULL OR p_revenue_count NOT BETWEEN 1 AND 25000
     OR p_target_count IS NULL OR p_target_count NOT BETWEEN 0 AND 25000
     OR jsonb_typeof(p_plan) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Manifesto inválido' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_plan) NOT BETWEEN 1 AND 10000 OR octet_length(p_plan::text) > 1500000 THEN
    RAISE EXCEPTION 'Manifesto excede o limite por requisição' USING ERRCODE = '22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_plan) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR jsonb_typeof(item->'kind') IS DISTINCT FROM 'string' OR item->>'kind' NOT IN ('faturamento','metas')
       OR (item->>'hash') IS NULL OR (item->>'hash') !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(item->'start') IS DISTINCT FROM 'number'
       OR jsonb_typeof(item->'count') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Lote inválido' USING ERRCODE = '22023';
    END IF;
    n := (item->>'count')::integer;
    IF n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Contagem de lote inválida' USING ERRCODE = '22023'; END IF;
    IF item->>'kind' = 'faturamento' THEN
      IF (item->>'start')::integer <> offset_f THEN RAISE EXCEPTION 'Lacuna ou sobreposição no faturamento' USING ERRCODE = '22023'; END IF;
      offset_f := offset_f + n;
    ELSE
      IF (item->>'start')::integer <> offset_m THEN RAISE EXCEPTION 'Lacuna ou sobreposição nas metas' USING ERRCODE = '22023'; END IF;
      offset_m := offset_m + n;
    END IF;
  END LOOP;
  IF offset_f <> p_revenue_count OR offset_m <> p_target_count THEN RAISE EXCEPTION 'Contagens incompletas' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.dashboard_imports WHERE id = p_request_id)
     AND NOT EXISTS (SELECT 1 FROM public.dashboard_uploads WHERE id = p_request_id) THEN
    RAISE EXCEPTION 'Identificador já utilizado' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.dashboard_uploads(id,created_by,expected_version,file_name,revenue_count,target_count,plan)
  VALUES (p_request_id,actor,p_expected_version,btrim(p_file_name),p_revenue_count,p_target_count,p_plan)
  ON CONFLICT (id) DO NOTHING;
  SELECT * INTO u FROM public.dashboard_uploads WHERE id = p_request_id FOR UPDATE;
  IF u.created_by <> actor OR u.file_name <> btrim(p_file_name) OR u.revenue_count <> p_revenue_count
     OR u.target_count <> p_target_count OR u.plan <> p_plan THEN
    RAISE EXCEPTION 'Identificador reutilizado com outro conteúdo' USING ERRCODE = '23505';
  END IF;
  -- Retrying keeps the ORIGINAL expected version, even if the browser refreshed.
  IF u.committed_at IS NULL AND u.expires_at < now() THEN RAISE EXCEPTION 'Preparação expirada; selecione novamente o arquivo' USING ERRCODE = '22023'; END IF;
  RETURN u.id;
END $$;

CREATE FUNCTION public.dashboard_upload_chunk(p_request_id uuid, p_chunk_index integer, p_payload text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u public.dashboard_uploads; descriptor jsonb; data jsonb; existing jsonb; item jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.dashboard_is_admin() THEN RAISE EXCEPTION 'Administrador obrigatório' USING ERRCODE = '42501'; END IF;
  SELECT * INTO u FROM public.dashboard_uploads WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR u.created_by <> auth.uid() THEN RAISE EXCEPTION 'Preparação não autorizada' USING ERRCODE = '42501'; END IF;
  IF u.committed_at IS NULL AND u.expires_at < now() THEN RAISE EXCEPTION 'Preparação expirada' USING ERRCODE = '22023'; END IF;
  IF p_chunk_index IS NULL OR p_chunk_index < 0 OR p_chunk_index >= jsonb_array_length(u.plan)
     OR p_payload IS NULL OR octet_length(p_payload) > 500000 THEN
    RAISE EXCEPTION 'Lote excede o limite por requisição ou não pertence ao manifesto' USING ERRCODE = '22023';
  END IF;
  descriptor := u.plan->p_chunk_index;
  IF encode(sha256(convert_to(p_payload,'UTF8')),'hex') <> descriptor->>'hash' THEN
    RAISE EXCEPTION 'Checksum do lote inválido' USING ERRCODE = '22023';
  END IF;
  data := p_payload::jsonb;
  IF jsonb_typeof(data) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Estrutura de lote inválida' USING ERRCODE = '22023'; END IF;
  IF jsonb_array_length(data) <> (descriptor->>'count')::integer THEN RAISE EXCEPTION 'Contagem do lote inválida' USING ERRCODE = '22023'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(data) LOOP
    IF NOT public.dashboard_valid_row(item, descriptor->>'kind' = 'metas') THEN
      RAISE EXCEPTION 'Linha de lote inválida' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  SELECT rows INTO existing FROM public.dashboard_upload_chunks WHERE upload_id = u.id AND chunk_index = p_chunk_index;
  IF FOUND THEN
    IF existing <> data THEN RAISE EXCEPTION 'Lote repetido com outro conteúdo' USING ERRCODE = '23505'; END IF;
    RETURN u.id;
  END IF;
  IF u.committed_at IS NOT NULL THEN RAISE EXCEPTION 'Versão já concluída' USING ERRCODE = '22023'; END IF;
  -- Canonical JSON bytes plus conservative JSONB spacing overhead per row.
  INSERT INTO public.dashboard_upload_chunks(upload_id,chunk_index,rows,byte_bound)
  VALUES (u.id,p_chunk_index,data,octet_length(p_payload) + 100 * jsonb_array_length(data));
  RETURN u.id;
END $$;

CREATE FUNCTION public.dashboard_upload_commit(p_request_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u public.dashboard_uploads; active_id uuid; actor_label text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.dashboard_is_admin() THEN RAISE EXCEPTION 'Administrador obrigatório' USING ERRCODE = '42501'; END IF;
  SELECT * INTO u FROM public.dashboard_uploads WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR u.created_by <> auth.uid() THEN RAISE EXCEPTION 'Preparação não autorizada' USING ERRCODE = '42501'; END IF;
  IF u.committed_at IS NOT NULL THEN RETURN u.id; END IF;
  IF u.expires_at < now() THEN RAISE EXCEPTION 'Preparação expirada' USING ERRCODE = '22023'; END IF;
  IF (SELECT count(*) FROM public.dashboard_upload_chunks WHERE upload_id = u.id) <> jsonb_array_length(u.plan) THEN
    RAISE EXCEPTION 'Preparação incompleta; nenhum dado foi publicado' USING ERRCODE = '22023';
  END IF;
  SELECT active_import_id INTO active_id FROM public.dashboard_settings WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Configuração ausente' USING ERRCODE = '22023'; END IF;
  IF active_id IS DISTINCT FROM u.expected_version THEN RAISE EXCEPTION 'Outra publicação alterou a base ativa' USING ERRCODE = '40001'; END IF;
  SELECT COALESCE(email,auth.uid()::text) INTO actor_label FROM auth.users WHERE id = auth.uid();
  INSERT INTO public.dashboard_imports(id,file_name,created_by,created_by_label,revenue_count,target_count)
  VALUES (u.id,u.file_name,u.created_by,actor_label,u.revenue_count,u.target_count);
  INSERT INTO public.dashboard_faturamento(import_id,row_index,data)
  SELECT u.id,(u.plan->c.chunk_index->>'start')::integer + item.ordinal::integer,item.value
  FROM public.dashboard_upload_chunks c CROSS JOIN LATERAL jsonb_array_elements(c.rows) WITH ORDINALITY item(value,ordinal)
  WHERE c.upload_id = u.id AND u.plan->c.chunk_index->>'kind' = 'faturamento';
  INSERT INTO public.dashboard_metas(import_id,row_index,data)
  SELECT u.id,(u.plan->c.chunk_index->>'start')::integer + item.ordinal::integer,item.value
  FROM public.dashboard_upload_chunks c CROSS JOIN LATERAL jsonb_array_elements(c.rows) WITH ORDINALITY item(value,ordinal)
  WHERE c.upload_id = u.id AND u.plan->c.chunk_index->>'kind' = 'metas';
  IF (SELECT count(*) FROM public.dashboard_faturamento WHERE import_id = u.id) <> u.revenue_count
     OR (SELECT count(*) FROM public.dashboard_metas WHERE import_id = u.id) <> u.target_count THEN
    RAISE EXCEPTION 'Contagens finais inconsistentes' USING ERRCODE = '22023';
  END IF;
  UPDATE public.dashboard_settings SET active_import_id = u.id WHERE singleton;
  UPDATE public.dashboard_uploads SET committed_at = now() WHERE id = u.id;
  RETURN u.id;
END $$;
REVOKE ALL ON FUNCTION public.dashboard_upload_begin(uuid,uuid,text,integer,integer,jsonb),
  public.dashboard_upload_chunk(uuid,integer,text),public.dashboard_upload_commit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dashboard_upload_begin(uuid,uuid,text,integer,integer,jsonb),
  public.dashboard_upload_chunk(uuid,integer,text),public.dashboard_upload_commit(uuid) TO authenticated;

-- Small metadata responses allow large snapshots to be fetched in bounded pages.
CREATE FUNCTION public.dashboard_read_manifest() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE active_id uuid; can_read boolean; is_admin boolean := public.dashboard_is_admin(); meta jsonb; bytes bigint;
BEGIN
  SELECT active_import_id,public_read_enabled INTO active_id,can_read FROM public.dashboard_settings WHERE singleton;
  IF NOT (COALESCE(can_read,false) OR is_admin) THEN RETURN jsonb_build_object('access',false,'isAdmin',is_admin,'manifest',NULL); END IF;
  IF active_id IS NULL THEN RETURN jsonb_build_object('access',true,'isAdmin',is_admin,'manifest',NULL); END IF;
  SELECT to_jsonb(i) - 'created_by' - 'created_by_label' INTO meta FROM public.dashboard_imports i WHERE id = active_id;
  -- New versions need only a few small counters, not a whole-dataset aggregation.
  SELECT sum(c.byte_bound) + 1024 INTO bytes FROM public.dashboard_upload_chunks c
  JOIN public.dashboard_uploads u ON u.id = c.upload_id
  WHERE u.id = active_id AND u.committed_at IS NOT NULL;
  IF bytes IS NULL THEN
    -- Compatibility with versions written by the original RPC.
    SELECT COALESCE(sum(size),0) + 1024 INTO bytes FROM (
      SELECT octet_length(data::text) AS size FROM public.dashboard_faturamento WHERE import_id = active_id
      UNION ALL SELECT octet_length(data::text) FROM public.dashboard_metas WHERE import_id = active_id
    ) sizes;
  END IF;
  RETURN jsonb_build_object('access',true,'isAdmin',is_admin,'manifest',jsonb_build_object('import',meta,'bytes',bytes));
END $$;

CREATE FUNCTION public.dashboard_read_page(p_import_id uuid,p_kind text,p_offset integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE active_id uuid; can_read boolean; result jsonb := '[]'; item jsonb; used integer := 0; n integer := 0; size integer;
BEGIN
  SELECT active_import_id,public_read_enabled INTO active_id,can_read FROM public.dashboard_settings WHERE singleton;
  IF NOT (COALESCE(can_read,false) OR public.dashboard_is_admin()) THEN RAISE EXCEPTION 'Leitura não autorizada' USING ERRCODE = '42501'; END IF;
  IF active_id IS DISTINCT FROM p_import_id THEN RAISE EXCEPTION 'A versão ativa mudou durante a leitura' USING ERRCODE = '40001'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('faturamento','metas') OR p_offset IS NULL OR p_offset < 0 THEN RAISE EXCEPTION 'Página inválida' USING ERRCODE = '22023'; END IF;
  FOR item IN
    SELECT data FROM (
      SELECT row_index,data FROM public.dashboard_faturamento WHERE import_id = p_import_id AND p_kind = 'faturamento' AND row_index > p_offset
      UNION ALL SELECT row_index,data FROM public.dashboard_metas WHERE import_id = p_import_id AND p_kind = 'metas' AND row_index > p_offset
    ) page ORDER BY row_index LIMIT 500
  LOOP
    size := octet_length(item::text) + 1;
    IF used + size > 400000 AND n > 0 THEN EXIT; END IF;
    result := result || jsonb_build_array(item); used := used + size; n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('rows',result,'nextOffset',p_offset+n);
END $$;
REVOKE ALL ON FUNCTION public.dashboard_read_manifest(),public.dashboard_read_page(uuid,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dashboard_read_manifest(),public.dashboard_read_page(uuid,text,integer) TO anon,authenticated;

-- Make the added RPCs discoverable immediately by PostgREST after commit.
NOTIFY pgrst, 'reload schema';
