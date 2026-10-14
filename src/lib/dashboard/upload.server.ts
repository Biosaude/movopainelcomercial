import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import {
  bearerToken,
  dashboardConfig,
  DashboardError,
  requestClient,
  verifySession,
} from "./shared.server";
import type { UploadManifest, SnapshotPage } from "./batches";

async function rpc(name: string, args: Record<string, unknown>, administrative: boolean) {
  setResponseHeader("Cache-Control", "private, no-store");
  const config = dashboardConfig();
  if (!config) throw new DashboardError("configuration", "Supabase não configurado.");
  const token = bearerToken(getRequest().headers.get("authorization"));
  const client = requestClient(config, token);
  await verifySession(client, token, administrative);
  if (administrative) {
    const permission = await client.rpc("dashboard_is_admin");
    if (permission.error || permission.data !== true)
      throw new DashboardError("forbidden", "Sua conta não possui permissão administrativa.");
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
      code: error instanceof DashboardError ? error.code : "transfer",
      message:
        error instanceof DashboardError
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
        true,
      ) as Promise<string>,
  );
}
export function appendUpload(data: { requestId: string; index: number; payload: string }) {
  return result(
    () =>
      rpc(
        "dashboard_upload_chunk",
        { p_request_id: data.requestId, p_chunk_index: data.index, p_payload: data.payload },
        true,
      ) as Promise<string>,
  );
}
export function commitUpload(data: { requestId: string }) {
  return result(
    () => rpc("dashboard_upload_commit", { p_request_id: data.requestId }, true) as Promise<string>,
  );
}
export function readPage(data: {
  importId: string;
  kind: "faturamento" | "metas";
  offset: number;
}) {
  return result(
    () =>
      rpc(
        "dashboard_read_page",
        { p_import_id: data.importId, p_kind: data.kind, p_offset: data.offset },
        false,
      ) as Promise<SnapshotPage>,
  );
}
