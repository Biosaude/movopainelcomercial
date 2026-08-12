
DROP VIEW IF EXISTS public.vw_dashboard_representante CASCADE;
DROP VIEW IF EXISTS public.vw_metas_representante_validacao CASCADE;

ALTER TABLE public.faturamento_comercial DROP COLUMN IF EXISTS linha CASCADE;
ALTER TABLE public.faturamento_comercial ADD COLUMN IF NOT EXISTS uf TEXT NOT NULL DEFAULT '';

ALTER TABLE public.metas_representante DROP COLUMN IF EXISTS linha CASCADE;
ALTER TABLE public.metas_representante ADD COLUMN IF NOT EXISTS uf TEXT NOT NULL DEFAULT '';

CREATE VIEW public.vw_dashboard_representante
WITH (security_invoker = true) AS
SELECT
  m.periodo, m.gr, m.representante, m.uf, m.marca, m.topico_produto, m.tipo_produto,
  m.meta,
  COALESCE(SUM(f.valor), 0) AS faturamento,
  CASE WHEN m.meta > 0 THEN COALESCE(SUM(f.valor),0) / m.meta ELSE NULL END AS atingimento_meta
FROM public.metas_representante m
LEFT JOIN public.faturamento_comercial f
  ON f.periodo = m.periodo
 AND f.gr = m.gr
 AND f.representante = m.representante
 AND f.uf = m.uf
 AND f.marca = m.marca
 AND f.topico_produto = m.topico_produto
 AND f.tipo_produto = m.tipo_produto
GROUP BY m.periodo, m.gr, m.representante, m.uf, m.marca, m.topico_produto, m.tipo_produto, m.meta;

CREATE VIEW public.vw_metas_representante_validacao
WITH (security_invoker = true) AS
SELECT periodo, gr, representante, uf, marca, topico_produto, tipo_produto,
       SUM(meta) AS meta_total, COUNT(*) AS registros
FROM public.metas_representante
GROUP BY periodo, gr, representante, uf, marca, topico_produto, tipo_produto;

GRANT SELECT ON public.vw_dashboard_representante TO anon, authenticated;
GRANT SELECT ON public.vw_metas_representante_validacao TO anon, authenticated;

ALTER TABLE public.metas_representante
  DROP CONSTRAINT IF EXISTS metas_representante_unique_key;
ALTER TABLE public.metas_representante
  ADD CONSTRAINT metas_representante_unique_key
  UNIQUE (periodo, gr, representante, uf, marca, topico_produto, tipo_produto);
