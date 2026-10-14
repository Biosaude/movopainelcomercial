import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  normalizePublication,
  publicationSchema,
  type ImportRecord,
  type Publication,
  type SharedSnapshot,
} from "./shared";

export type PublicConfig = { url: string; publishableKey: string };
export class DashboardError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function dashboardConfig(): PublicConfig | null {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const publishableKey =
    process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return null;
  let role: unknown;
  try {
    role = JSON.parse(Buffer.from(publishableKey.split(".")[1], "base64url").toString()).role;
  } catch {
    /* opaque publishable key */
  }
  if (publishableKey.startsWith("sb_secret_") || role === "service_role") {
    throw new DashboardError(
      "configuration",
      "Configure uma chave pública do Supabase, nunca uma chave administrativa.",
    );
  }
  return { url, publishableKey };
}
export function requestClient(config: PublicConfig, token?: string) {
  return createClient(config.url, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  });
}
export function bearerToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match) throw new DashboardError("unauthorized", "Sessão inválida. Entre novamente.");
  return match[1];
}
export async function verifySession(client: SupabaseClient, token?: string, required = false) {
  if (!token) {
    if (required) throw new DashboardError("unauthorized", "Entre com uma conta administrativa.");
    return;
  }
  // Remote Auth validation, not merely decoding the JWT or trusting frontend state.
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user)
    throw new DashboardError("unauthorized", "Sessão inválida. Entre novamente.");
  return data.user;
}
export async function readDashboard(client: SupabaseClient, token?: string) {
  await verifySession(client, token);
  const { data, error } = await client.rpc("dashboard_read_snapshot");
  if (error)
    throw new DashboardError(
      "unavailable",
      "Não foi possível consultar a base compartilhada. Verifique a conexão e a migração do Supabase.",
    );
  const state = data as { access: boolean; isAdmin: boolean; snapshot: SharedSnapshot | null };
  if (!state?.access)
    throw new DashboardError(
      "forbidden",
      "A leitura pública está desativada. Entre com uma conta autorizada.",
    );
  let history: ImportRecord[] = [];
  if (state.isAdmin) {
    const result = await client
      .from("dashboard_imports")
      .select("id,published_at,file_name,revenue_count,target_count,created_by_label")
      .order("published_at", { ascending: false })
      .limit(50);
    if (result.error)
      throw new DashboardError(
        "unavailable",
        "Não foi possível consultar o histórico de importações.",
      );
    history = result.data ?? [];
  }
  return { ...state, history };
}
export async function publishDashboard(
  client: SupabaseClient,
  token: string | undefined,
  payload: Publication,
) {
  await verifySession(client, token, true);
  const permission = await client.rpc("dashboard_is_admin");
  if (permission.error || permission.data !== true)
    throw new DashboardError("forbidden", "Sua conta não possui permissão administrativa.");
  const value = normalizePublication(publicationSchema.parse(payload));
  const { data, error } = await client.rpc("dashboard_publish", {
    p_request_id: value.requestId,
    p_expected_version: value.expectedVersion,
    p_file_name: value.fileName,
    p_faturamento: value.faturamento,
    p_metas: value.metas,
  });
  if (error) {
    if (error.code === "40001")
      throw new DashboardError(
        "conflict",
        "Outro administrador atualizou a base. Recarregue a base compartilhada e revise a importação antes de tentar novamente.",
      );
    throw new DashboardError(
      "publication",
      "Não foi possível publicar. A base compartilhada foi preservada; confira a conexão e os dados antes de tentar novamente.",
    );
  }
  return data as string;
}
