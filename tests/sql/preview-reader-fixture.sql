-- Local-only stand-ins for the relations owned by the original legacy imports.
CREATE TABLE public.faturamento_comercial (id integer);
CREATE TABLE public.metas_representante (id integer);
CREATE VIEW public.vw_dashboard_representante AS SELECT id FROM public.faturamento_comercial;
CREATE VIEW public.vw_metas_representante_validacao AS SELECT id FROM public.metas_representante;
GRANT SELECT ON public.faturamento_comercial, public.metas_representante,
  public.vw_dashboard_representante, public.vw_metas_representante_validacao TO anon, authenticated;
CREATE ROLE commercial_preview_reader LOGIN;
