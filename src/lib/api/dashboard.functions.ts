import { createServerFn } from "@tanstack/react-start";
import { publicationSchema } from "../dashboard/shared";

// Public reads intentionally do not use the old global Supabase auth attacher.
export const getDashboardState = createServerFn({ method: "GET" }).handler(async () => {
  const { getRequest, setResponseHeader } = await import("@tanstack/react-start/server");
  const api = await import("../dashboard/shared.server");
  setResponseHeader("Cache-Control", "private, no-store");
  let config: import("../dashboard/shared.server").PublicConfig | null = null;
  try {
    config = api.dashboardConfig();
    if (!config && process.env.NODE_ENV === "production")
      return {
        ok: false as const,
        config,
        code: "configuration",
        message: "A base compartilhada ainda não está configurada.",
      };
    if (!config) {
      const base = await import("../dashboard/embedded.server");
      return {
        ok: true as const,
        config,
        access: true,
        isAdmin: false,
        snapshot: null,
        history: [],
        embedded: { faturamento: base.INITIAL_FAT, metas: base.INITIAL_METAS },
        message:
          "Supabase não configurado neste ambiente de desenvolvimento. Exibindo a base embarcada.",
      };
    }
    const token = api.bearerToken(getRequest().headers.get("authorization"));
    const state = await api.readDashboard(api.requestClient(config, token), token);
    const base = state.snapshot ? null : await import("../dashboard/embedded.server");
    return {
      ok: true as const,
      config,
      ...state,
      embedded: base ? { faturamento: base.INITIAL_FAT, metas: base.INITIAL_METAS } : null,
      message: state.snapshot ? "" : "Ainda não há uma base publicada. Exibindo a base embarcada.",
    };
  } catch (error) {
    return {
      ok: false as const,
      config,
      code: error instanceof api.DashboardError ? error.code : "unavailable",
      message:
        error instanceof api.DashboardError
          ? error.message
          : "A base compartilhada está indisponível. Tente recarregar.",
    };
  }
});

export const publishSharedDashboard = createServerFn({ method: "POST" })
  .validator(publicationSchema)
  .handler(async ({ data }) => {
    const { getRequest, setResponseHeader } = await import("@tanstack/react-start/server");
    const api = await import("../dashboard/shared.server");
    setResponseHeader("Cache-Control", "private, no-store");
    try {
      const config = api.dashboardConfig();
      if (!config) throw new api.DashboardError("configuration", "Supabase não configurado.");
      const token = api.bearerToken(getRequest().headers.get("authorization"));
      const id = await api.publishDashboard(api.requestClient(config, token), token, data);
      return { ok: true as const, id };
    } catch (error) {
      return {
        ok: false as const,
        code: error instanceof api.DashboardError ? error.code : "publication",
        message:
          error instanceof api.DashboardError ? error.message : "Não foi possível publicar a base.",
      };
    }
  });
