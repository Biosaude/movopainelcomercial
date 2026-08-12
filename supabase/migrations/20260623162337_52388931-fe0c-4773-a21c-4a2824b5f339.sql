DROP VIEW IF EXISTS public.vw_dashboard_representante;
DROP VIEW IF EXISTS public.vw_metas_representante_validacao;
DROP VIEW IF EXISTS public.vw_dashboard_uf;
DROP VIEW IF EXISTS public.vw_metas_uf_validacao;
DROP VIEW IF EXISTS public.vw_metas_por_uf;
DROP VIEW IF EXISTS public.vw_meta_uf;

DROP TABLE IF EXISTS public.metas_uf CASCADE;
DROP TABLE IF EXISTS public.metas_por_uf CASCADE;
DROP TABLE IF EXISTS public.meta_uf CASCADE;

CREATE TABLE IF NOT EXISTS public.metas_representante_nova (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  periodo text NOT NULL,
  gr text NOT NULL,
  representante text NOT NULL,
  marca text NOT NULL,
  linha text NOT NULL,
  topico_produto text NOT NULL,
  tipo_produto text NOT NULL,
  meta numeric NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT metas_representante_nova_meta_nao_negativa CHECK (meta >= 0),
  CONSTRAINT metas_representante_nova_periodo_not_blank CHECK (btrim(periodo) <> ''),
  CONSTRAINT metas_representante_nova_gr_not_blank CHECK (btrim(gr) <> ''),
  CONSTRAINT metas_representante_nova_representante_not_blank CHECK (btrim(representante) <> ''),
  CONSTRAINT metas_representante_nova_marca_not_blank CHECK (btrim(marca) <> ''),
  CONSTRAINT metas_representante_nova_linha_not_blank CHECK (btrim(linha) <> ''),
  CONSTRAINT metas_representante_nova_topico_not_blank CHECK (btrim(topico_produto) <> ''),
  CONSTRAINT metas_representante_nova_tipo_not_blank CHECK (btrim(tipo_produto) <> '')
);

GRANT SELECT ON public.metas_representante_nova TO anon, authenticated;
GRANT ALL ON public.metas_representante_nova TO service_role;

ALTER TABLE public.metas_representante_nova ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Metas por representante ficam visiveis no dashboard" ON public.metas_representante_nova;
CREATE POLICY "Metas por representante ficam visiveis no dashboard"
ON public.metas_representante_nova
FOR SELECT
TO anon, authenticated
USING (true);

INSERT INTO public.metas_representante_nova (
  periodo,
  gr,
  representante,
  marca,
  linha,
  topico_produto,
  tipo_produto,
  meta,
  created_at,
  updated_at
)
SELECT
  btrim(periodo) AS periodo,
  btrim(gr) AS gr,
  btrim(representante) AS representante,
  btrim(marca) AS marca,
  btrim(linha) AS linha,
  btrim(topico_produto) AS topico_produto,
  btrim(tipo_produto) AS tipo_produto,
  sum(meta) AS meta,
  min(created_at) AS created_at,
  max(updated_at) AS updated_at
FROM public.metas_representante
WHERE btrim(periodo) <> ''
  AND btrim(gr) <> ''
  AND btrim(representante) <> ''
  AND btrim(marca) <> ''
  AND btrim(linha) <> ''
  AND btrim(topico_produto) <> ''
  AND btrim(tipo_produto) <> ''
GROUP BY
  btrim(periodo),
  btrim(gr),
  btrim(representante),
  btrim(marca),
  btrim(linha),
  btrim(topico_produto),
  btrim(tipo_produto);

DROP TABLE public.metas_representante CASCADE;
ALTER TABLE public.metas_representante_nova RENAME TO metas_representante;

ALTER TABLE public.metas_representante
  RENAME CONSTRAINT metas_representante_nova_meta_nao_negativa TO metas_representante_meta_nao_negativa;
ALTER TABLE public.metas_representante
  RENAME CONSTRAINT metas_representante_nova_periodo_not_blank TO metas_representante_periodo_not_blank;
ALTER TABLE public.metas_representante
  RENAME CONSTRAINT metas_representante_nova_gr_not_blank TO metas_representante_gr_not_blank;
ALTER TABLE public.metas_representante
  RENAME CONSTRAINT metas_representante_nova_representante_not_blank TO metas_representante_representante_not_blank;
ALTER TABLE public.metas_representante
  RENAME CONSTRAINT metas_representante_nova_marca_not_blank TO metas_representante_marca_not_blank;
ALTER TABLE public.metas_representante
  RENAME CONSTRAINT metas_representante_nova_linha_not_blank TO metas_representante_linha_not_blank;
ALTER TABLE public.metas_representante
  RENAME CONSTRAINT metas_representante_nova_topico_not_blank TO metas_representante_topico_not_blank;
ALTER TABLE public.metas_representante
  RENAME CONSTRAINT metas_representante_nova_tipo_not_blank TO metas_representante_tipo_not_blank;

ALTER TABLE public.metas_representante
  ADD CONSTRAINT metas_representante_chave_unica UNIQUE (
    periodo,
    gr,
    representante,
    marca,
    linha,
    topico_produto,
    tipo_produto
  );

CREATE INDEX IF NOT EXISTS idx_metas_representante_chave_dashboard
ON public.metas_representante (
  periodo,
  gr,
  representante,
  marca,
  linha,
  topico_produto,
  tipo_produto
);

DROP TRIGGER IF EXISTS update_metas_representante_updated_at ON public.metas_representante;
CREATE TRIGGER update_metas_representante_updated_at
BEFORE UPDATE ON public.metas_representante
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

GRANT SELECT ON public.metas_representante TO anon, authenticated;
GRANT ALL ON public.metas_representante TO service_role;

DROP POLICY IF EXISTS "Metas por representante ficam visiveis no dashboard" ON public.metas_representante;
CREATE POLICY "Metas por representante ficam visiveis no dashboard"
ON public.metas_representante
FOR SELECT
TO anon, authenticated
USING (true);

CREATE OR REPLACE VIEW public.vw_metas_representante_validacao AS
SELECT
  periodo,
  gr,
  representante,
  marca,
  linha,
  topico_produto,
  tipo_produto,
  count(*) AS registros,
  sum(meta) AS meta_total
FROM public.metas_representante
GROUP BY
  periodo,
  gr,
  representante,
  marca,
  linha,
  topico_produto,
  tipo_produto;

CREATE OR REPLACE VIEW public.vw_dashboard_representante AS
WITH faturamento_agg AS (
  SELECT
    periodo,
    gr,
    representante,
    marca,
    linha,
    topico_produto,
    tipo_produto,
    sum(valor) AS faturamento
  FROM public.faturamento_comercial
  GROUP BY
    periodo,
    gr,
    representante,
    marca,
    linha,
    topico_produto,
    tipo_produto
)
SELECT
  COALESCE(f.periodo, m.periodo) AS periodo,
  COALESCE(f.gr, m.gr) AS gr,
  COALESCE(f.representante, m.representante) AS representante,
  COALESCE(f.marca, m.marca) AS marca,
  COALESCE(f.linha, m.linha) AS linha,
  COALESCE(f.topico_produto, m.topico_produto) AS topico_produto,
  COALESCE(f.tipo_produto, m.tipo_produto) AS tipo_produto,
  COALESCE(f.faturamento, 0::numeric) AS faturamento,
  m.meta,
  CASE
    WHEN m.meta IS NULL OR m.meta = 0 THEN NULL::numeric
    ELSE COALESCE(f.faturamento, 0::numeric) / m.meta * 100::numeric
  END AS atingimento_meta
FROM public.metas_representante m
LEFT JOIN faturamento_agg f
  ON f.periodo = m.periodo
 AND f.gr = m.gr
 AND f.representante = m.representante
 AND f.marca = m.marca
 AND f.linha = m.linha
 AND f.topico_produto = m.topico_produto
 AND f.tipo_produto = m.tipo_produto
UNION ALL
SELECT
  f.periodo,
  f.gr,
  f.representante,
  f.marca,
  f.linha,
  f.topico_produto,
  f.tipo_produto,
  f.faturamento,
  NULL::numeric AS meta,
  NULL::numeric AS atingimento_meta
FROM faturamento_agg f
WHERE NOT EXISTS (
  SELECT 1
  FROM public.metas_representante m
  WHERE m.periodo = f.periodo
    AND m.gr = f.gr
    AND m.representante = f.representante
    AND m.marca = f.marca
    AND m.linha = f.linha
    AND m.topico_produto = f.topico_produto
    AND m.tipo_produto = f.tipo_produto
);

GRANT SELECT ON public.vw_metas_representante_validacao TO anon, authenticated;
GRANT SELECT ON public.vw_dashboard_representante TO anon, authenticated;
GRANT ALL ON public.vw_metas_representante_validacao TO service_role;
GRANT ALL ON public.vw_dashboard_representante TO service_role;