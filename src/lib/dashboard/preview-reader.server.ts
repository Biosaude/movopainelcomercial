import { Pool } from "pg";
import type { SnapshotPage } from "./batches";
import { DashboardError, type PublicConfig } from "./shared.server";

const readerRole = "commercial_preview_reader";
const readFunctions = [
  "public.dashboard_read_manifest()",
  "public.dashboard_read_snapshot()",
  "public.dashboard_read_page(uuid,text,integer)",
  "public.dashboard_preview_read_history()",
];

const protectedRelations = [
  "dashboard_imports",
  "dashboard_faturamento",
  "dashboard_metas",
  "dashboard_settings",
  "dashboard_uploads",
  "dashboard_upload_chunks",
  "faturamento_comercial",
  "metas_representante",
  "vw_dashboard_representante",
  "vw_metas_representante_validacao",
];

export function previewReaderSettings(
  config: PublicConfig,
  value = process.env.COMMERCIAL_PREVIEW_READER_DATABASE_URL,
) {
  const project = /^([a-z0-9]+)\.supabase\.co$/.exec(new URL(config.url).hostname)?.[1];
  const url = value && URL.parse(value);
  const direct =
    project && url && url.hostname === `db.${project}.supabase.co` && url.username === readerRole;
  const pooled =
    project &&
    url &&
    /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) &&
    url.username === `${readerRole}.${project}`;
  if (
    (!direct && !pooled) ||
    !url ||
    url.protocol !== "postgresql:" ||
    (url.port && url.port !== "5432") ||
    url.pathname !== "/postgres" ||
    !url.password ||
    url.hash ||
    url.search !== "?sslmode=verify-full"
  )
    throw new DashboardError(
      "configuration",
      "Configure o leitor PostgreSQL exclusivo do Supabase de homologação.",
    );
  return {
    host: url.hostname,
    port: 5432,
    database: "postgres",
    user: url.username,
    password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 4000,
    statement_timeout: 8000,
    max: 3,
  };
}

const statements = {
  manifest: "SELECT public.dashboard_read_manifest() AS data",
  snapshot: "SELECT public.dashboard_read_snapshot() AS data",
  page: "SELECT public.dashboard_read_page($1::uuid, $2::text, $3::integer) AS data",
  history: "SELECT public.dashboard_preview_read_history() AS data",
};
let pool: Pool | undefined;
export async function readPreview<T>(
  config: PublicConfig,
  operation: keyof typeof statements,
  values: (string | number)[] = [],
): Promise<T> {
  const settings = previewReaderSettings(config);
  if (!pool) {
    pool = new Pool(settings);
    // The pool discards broken idle connections. Active calls fail through the request handler.
    pool.on("error", () => {});
  }
  const connection = await pool.connect();
  let discard = false;
  try {
    await connection.query("BEGIN READ ONLY");
    const {
      rows: [security],
    } = await connection.query<{ ready: boolean }>(
      `SELECT current_user = $2 AND session_user = $2
         AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user
           AND r.rolcanlogin
           AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid))
         AND NOT pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE')
         AND NOT EXISTS (
           SELECT 1 FROM unnest($1::text[]) f
           WHERE pg_catalog.has_function_privilege('anon', f, 'EXECUTE')
              OR pg_catalog.has_function_privilege('authenticated', f, 'EXECUTE')
              OR NOT pg_catalog.has_function_privilege(current_user, f, 'EXECUTE')
         ) AND NOT EXISTS (
           SELECT 1
           FROM unnest($3::text[]) AS relation(name)
           CROSS JOIN unnest(ARRAY['anon','authenticated',current_user::text]) AS principal(name)
           WHERE pg_catalog.has_any_column_privilege(principal.name, pg_catalog.to_regclass('public.' || relation.name), 'SELECT')
         ) AS ready`,
      [readFunctions, readerRole, protectedRelations],
    );
    if (!security?.ready)
      throw new DashboardError(
        "configuration",
        "A proteção das RPCs do Supabase de homologação ainda não está ativa.",
      );
    const {
      rows: [result],
    } = await connection.query<{ data: T }>(statements[operation], values);
    await connection.query("COMMIT");
    return result.data;
  } catch (error) {
    try {
      await connection.query("ROLLBACK");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    connection.release(discard);
  }
}

export async function readPreviewPage(
  config: PublicConfig,
  data: {
    importId: string;
    kind: "faturamento" | "metas";
    offset: number;
  },
) {
  try {
    return await readPreview<SnapshotPage>(config, "page", [data.importId, data.kind, data.offset]);
  } catch (error) {
    if ((error as { code?: string }).code === "40001")
      throw new DashboardError("conflict", "A versão ativa mudou. Recarregue a base.");
    throw error;
  }
}
