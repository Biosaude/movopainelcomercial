CREATE TABLE public.dashboard_base_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  published_at timestamp with time zone NOT NULL DEFAULT now(),
  file_name text NOT NULL CHECK (btrim(file_name) <> ''),
  faturamento_count integer NOT NULL CHECK (faturamento_count > 0),
  metas_count integer NOT NULL CHECK (metas_count > 0),
  faturamento jsonb NOT NULL CHECK (jsonb_typeof(faturamento) = 'array'),
  metas jsonb NOT NULL CHECK (jsonb_typeof(metas) = 'array'),
  is_current boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX dashboard_base_one_current
  ON public.dashboard_base_versions (is_current)
  WHERE is_current;

ALTER TABLE public.dashboard_base_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dashboard_base_versions FROM anon, authenticated;
GRANT ALL ON public.dashboard_base_versions TO service_role;

CREATE OR REPLACE FUNCTION public.publish_dashboard_base(
  p_file_name text,
  p_faturamento jsonb,
  p_metas jsonb
)
RETURNS SETOF public.dashboard_base_versions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  published public.dashboard_base_versions;
BEGIN
  IF btrim(p_file_name) = ''
     OR jsonb_typeof(p_faturamento) <> 'array'
     OR jsonb_array_length(p_faturamento) = 0
     OR jsonb_typeof(p_metas) <> 'array'
     OR jsonb_array_length(p_metas) = 0 THEN
    RAISE EXCEPTION 'A base publicada deve conter nome, faturamento e metas válidos';
  END IF;

  UPDATE public.dashboard_base_versions SET is_current = false WHERE is_current;
  INSERT INTO public.dashboard_base_versions (
    file_name, faturamento_count, metas_count, faturamento, metas, is_current
  ) VALUES (
    p_file_name, jsonb_array_length(p_faturamento), jsonb_array_length(p_metas),
    p_faturamento, p_metas, true
  ) RETURNING * INTO published;

  RETURN NEXT published;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_dashboard_base(text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_dashboard_base(text, jsonb, jsonb) TO service_role;
