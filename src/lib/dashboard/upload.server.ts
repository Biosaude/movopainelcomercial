import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import {
  bearerToken,
  dashboardConfig,
  DashboardError,
  requestClient,
  verifySession,
  verifyAdministrator,
} from "./shared.server";
import type { UploadManifest, SnapshotPage } from "./batches";
import { CorporateAccessError } from "../corporate/access";
import { requireCorporateRead } from "../corporate/auth.server";

const publicationOperations = {
  dashboard_upload_begin: "begin",
  dashboard_upload_chunk: "chunk",
  dashboard_upload_commit: "commit",
} as const;

async function rpc(name: keyof typeof publicationOperations | "dashboard_read_page", args: Record<string, unknown>) {
  setResponseHeader("Cache-Control", "private, no-store");
  const config = dashboardConfig();
  if (!config) throw new DashboardError("configuration", "Supabase não configurado.");
  const token = bearerToken(getRequest().headers.get("authorization"));
  const client = requestClient(config, token);
  if (name === "dashboard_read_page") {
    await verifySession(client, token);
  } else {
    await requireCorporateRead(getRequest());
    const user = await verifyAdministrator(client, token);
    if (process.env.VERCEL_ENV === "production") {
      const { publishWithDatabase } = await import("./production-publisher.server");
      const values = name === "dashboard_upload_begin"
        ? [args.p_request_id, args.p_expected_version, args.p_file_name, args.p_revenue_count, args.p_target_count, JSON.stringify(args.p_plan)]
        : name === "dashboard_upload_chunk"
          ? [args.p_request_id, args.p_chunk_index, args.p_payload]
          : [args.p_request_id];
      return publishWithDatabase(config, user.id, publicationOperations[name], values);
    }
  }
  const { data, error } = await client.rpc(name, args);
  if (error) {
    if (error.code === "PGRST202")
      throw new DashboardError(
        "configuration",
        "Aplique o SQL adicional de publicação em lotes antes de usar esta versão.",
      );
    if (error.code === "40001")
      throw new DashboardError(
        "conflict",
        "A versão ativa mudou. Recarregue a base e selecione novamente o arquivo antes de publicar.",
      );
    if (error.code === "23505")
      throw new DashboardError(
        "identity",
        "O identificador desta transferência já foi utilizado com outro conteúdo. Selecione novamente o arquivo.",
      );
    if (error.code === "42501")
      throw new DashboardError(
        "forbidden",
        "Sua sessão não tem permissão para esta transferência.",
      );
    throw new DashboardError(
      "transfer",
      "Não foi possível confirmar a transferência. Repetir a mesma seleção retoma os lotes sem duplicar registros; a base ativa só muda após a conclusão atômica.",
    );
  }
  return data;
}
async function result<T>(action: () => Promise<T>) {
  try {
    return { ok: true as const, data: await action() };
  } catch (error) {
    return {
      ok: false as const,
      code:
        error instanceof DashboardError || error instanceof CorporateAccessError
          ? error.code
          : "transfer",
      message:
        error instanceof DashboardError || error instanceof CorporateAccessError
          ? error.message
          : "Não foi possível concluir a transferência. Tente novamente.",
    };
  }
}
export function beginUpload(data: UploadManifest) {
  return result(
    () =>
      rpc(
        "dashboard_upload_begin",
        {
          p_request_id: data.requestId,
          p_expected_version: data.expectedVersion,
          p_file_name: data.fileName,
          p_revenue_count: data.revenueCount,
          p_target_count: data.targetCount,
          p_plan: data.plan,
        },
      ) as Promise<string>,
  );
}
export function appendUpload(data: { requestId: string; index: number; payload: string }) {
  return result(
    () =>
      rpc(
        "dashboard_upload_chunk",
        { p_request_id: data.requestId, p_chunk_index: data.index, p_payload: data.payload },
      ) as Promise<string>,
  );
}
export function commitUpload(data: { requestId: string }) {
  return result(() => rpc("dashboard_upload_commit", { p_request_id: data.requestId }) as Promise<string>);
}
export function readPage(data: {
  importId: string;
  kind: "faturamento" | "metas";
  offset: number;
}) {
  return result(async () => {
    setResponseHeader("Cache-Control", "private, no-store");
    if (await requireCorporateRead(getRequest())) {
      const config = dashboardConfig();
      if (!config) throw new DashboardError("configuration", "Supabase não configurado.");
      const { readPreviewPage } = await import("./preview-reader.server");
      return readPreviewPage(config, data);
    }
    return rpc(
      "dashboard_read_page",
      { p_import_id: data.importId, p_kind: data.kind, p_offset: data.offset },
    ) as Promise<SnapshotPage>;
  });
}
