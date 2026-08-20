import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Meta, Row } from "@/lib/dashboard/domain";
import type { Json } from "@/integrations/supabase/types";

const dashboardBaseSchema = z.object({
  faturamento: z.array(z.record(z.string(), z.unknown())).min(1),
  metas: z.array(z.record(z.string(), z.unknown())).min(1),
  fileName: z.string().trim().min(1).max(255),
});

export type PublishedDashboardBase = {
  faturamento: Row[];
  metas: Meta[];
  lastUpdate: {
    version: string;
    when: string;
    fileName: string;
    count: number;
    metaCount: number;
  };
};

export const getPublishedDashboardBase = createServerFn({ method: "GET" }).handler(
  async (): Promise<PublishedDashboardBase | null> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("dashboard_base_versions")
      .select("id, published_at, file_name, faturamento_count, metas_count, faturamento, metas")
      .eq("is_current", true)
      .maybeSingle();

    if (error) throw new Error(`Não foi possível carregar a base publicada: ${error.message}`);
    if (!data) return null;

    return {
      faturamento: data.faturamento as Row[],
      metas: data.metas as Meta[],
      lastUpdate: {
        version: data.id,
        when: data.published_at,
        fileName: data.file_name,
        count: data.faturamento_count,
        metaCount: data.metas_count,
      },
    };
  },
);

export const publishDashboardBase = createServerFn({ method: "POST" })
  .validator(dashboardBaseSchema)
  .handler(async ({ data }): Promise<PublishedDashboardBase["lastUpdate"]> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: published, error } = await supabaseAdmin.rpc("publish_dashboard_base", {
      p_file_name: data.fileName,
      p_faturamento: data.faturamento as Json,
      p_metas: data.metas as Json,
    });

    if (error) throw new Error(`Não foi possível publicar a base: ${error.message}`);
    const row = published?.[0];
    if (!row) throw new Error("A publicação não retornou a versão criada.");

    return {
      version: row.id,
      when: row.published_at,
      fileName: row.file_name,
      count: row.faturamento_count,
      metaCount: row.metas_count,
    };
  });
