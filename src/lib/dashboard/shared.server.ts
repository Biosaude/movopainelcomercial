import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  normalizePublication,
  legacyPublicationSchema,
  type ImportRecord,
  type Publication,
  type SharedSnapshot,
} from "./shared";
import { SMALL_SNAPSHOT_BYTES, type ReadManifest } from "./batches";
import { readPreview } from "./preview-reader.server";
import { corporatePreviewEnabled } from "../corporate/auth.server";

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
  const publicUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const production = process.env.VERCEL_ENV === "production";
  const corporate = !production && corporatePreviewEnabled();
  const url = corporate ? process.env.COMMERCIAL_PREVIEW_SUPABASE_URL : publicUrl;
  const publishableKey = corporate
    ? process.env.COMMERCIAL_PREVIEW_SUPABASE_PUBLISHABLE_KEY
    : process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return null;
  if (production) {
    const ref = process.env.COMMERCIAL_PRODUCTION_SUPABASE_REF;
    if (!ref || !/^[a-z0-9]+$/.test(ref) ||
        new URL(url).origin !== `https://${ref}.supabase.co` ||
        ![`https://${ref}.supabase.co`, `https://${ref}.supabase.co/`].includes(url) ||
        URL.parse(process.env.COMMERCIAL_PREVIEW_SUPABASE_URL ?? "")?.hostname === `${ref}.supabase.co`)
      throw new DashboardError("configuration", "Configuração operacional do Supabase Comercial inválida.");
  }
  if (corporate) {
    const preview = new URL(url);
    const loopback = preview.hostname === "localhost" || preview.hostname === "127.0.0.1";
    if (
      (preview.protocol !== "https:" &&
        !(loopback && process.env.VERCEL_ENV !== "preview" && preview.protocol === "http:")) ||
      preview.hostname === "yvsuaterzpekenlyzaoa.supabase.co" ||
      preview.origin === (publicUrl && new URL(publicUrl).origin) ||
      preview.username ||
      preview.password ||
      preview.pathname !== "/" ||
      preview.search ||
      preview.hash
    ) {
      throw new DashboardError(
        "configuration",
        "Configure um Supabase isolado para a homologação.",
      );
    }
  }
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
/** Revalidate management access server-side, including revoked administrator roles. */
export async function verifyAdministrator(client: SupabaseClient, token?: string) {
  const user = await verifySession(client, token, true);
  const permission = await client.rpc("dashboard_is_admin");
  if (!user || permission.error || permission.data !== true)
    throw new DashboardError("forbidden", "Sua conta não possui permissão administrativa.");
  return user;
}
export async function readDashboard(
  client: SupabaseClient,
  token?: string,
  preview?: PublicConfig,
) {
  await verifySession(client, token);
  type Metadata = { access: boolean; isAdmin: boolean; manifest: ReadManifest | null };
  type Snapshot = { access: boolean; isAdmin: boolean; snapshot: SharedSnapshot | null };
  const { data, error } = preview
    ? { data: await readPreview<Metadata>(preview, "manifest"), error: null }
    : await client.rpc("dashboard_read_manifest");
  if (error)
    throw new DashboardError(
      "unavailable",
      "Não foi possível consultar a base compartilhada. Verifique a conexão e a migração do Supabase.",
    );
  const metadata = data as Metadata;
  if (preview && token) {
    const permission = await client.rpc("dashboard_is_admin");
    if (permission.error)
      throw new DashboardError(
        "unavailable",
        "Não foi possível verificar a permissão administrativa.",
      );
    metadata.isAdmin = permission.data === true;
  }
  let state: {
    access: boolean;
    isAdmin: boolean;
    snapshot: SharedSnapshot | null;
    manifest: ReadManifest | null;
  } = { ...metadata, snapshot: null };
  if (metadata.access && (!metadata.manifest || metadata.manifest.bytes <= SMALL_SNAPSHOT_BYTES)) {
    const response = preview
      ? { data: await readPreview<Snapshot>(preview, "snapshot"), error: null }
      : await client.rpc("dashboard_read_snapshot");
    if (response.error)
      throw new DashboardError("unavailable", "Não foi possível consultar a base compartilhada.");
    const loaded = response.data as Snapshot;
    if (preview) loaded.isAdmin = metadata.isAdmin;
    // A concurrent publication may have replaced the small version with a large
    // one. Never send that full payload through the Vercel server function.
    const bytes = loaded.snapshot
      ? new TextEncoder().encode(JSON.stringify(loaded.snapshot)).byteLength
      : 0;
    state =
      bytes > SMALL_SNAPSHOT_BYTES && loaded.snapshot
        ? { ...loaded, snapshot: null, manifest: { import: loaded.snapshot.import, bytes } }
        : { ...loaded, manifest: null };
  }
  if (!state?.access)
    throw new DashboardError(
      "forbidden",
      "A leitura pública está desativada. Entre com uma conta autorizada.",
    );
  let history: ImportRecord[] = [];
  if (state.isAdmin && preview) {
    history = await readPreview<ImportRecord[]>(preview, "history");
  } else if (state.isAdmin) {
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
  const user = await verifyAdministrator(client, token);
  const value = normalizePublication(legacyPublicationSchema.parse(payload));
  if (process.env.VERCEL_ENV === "production") {
    const config = dashboardConfig();
    if (!config) throw new DashboardError("configuration", "Supabase não configurado.");
    const { publishWithDatabase } = await import("./production-publisher.server");
    return publishWithDatabase(config, user.id, "publish", [
      value.requestId, value.expectedVersion, value.fileName,
      JSON.stringify(value.faturamento), JSON.stringify(value.metas),
    ]);
  }
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
