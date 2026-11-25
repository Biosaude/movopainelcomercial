import { Pool } from "pg";
import { productionPublisherRole, restrictedDatabaseSettings } from "./preview-reader.server";
import { DashboardError, type PublicConfig } from "./shared.server";

const calls = {
  begin: "public.dashboard_upload_begin($1::uuid,$2::uuid,$3::text,$4::integer,$5::integer,$6::jsonb)",
  chunk: "public.dashboard_upload_chunk($1::uuid,$2::integer,$3::text)",
  commit: "public.dashboard_upload_commit($1::uuid)",
  publish: "public.dashboard_publish($1::uuid,$2::uuid,$3::text,$4::jsonb,$5::jsonb)",
};
let pool: Pool | undefined;

export async function publishWithDatabase(
  config: PublicConfig,
  actor: string,
  operation: keyof typeof calls,
  values: unknown[],
): Promise<string> {
  if (process.env.VERCEL_ENV !== "production" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(actor))
    throw new DashboardError("forbidden", "Identidade administrativa inválida.");
  if (!pool) {
    pool = new Pool(restrictedDatabaseSettings(config, process.env.COMMERCIAL_PRODUCTION_PUBLISHER_DATABASE_URL, productionPublisherRole));
    pool.on("error", () => {});
  }
  const connection = await pool.connect();
  let discard = false;
  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', json_build_object('sub', $1::text)::text, true)",
      [actor],
    );
    const { rows: [result] } = await connection.query<{ result: string }>(
      `SELECT ${calls[operation]} AS result`, values,
    );
    await connection.query("COMMIT");
    return result.result;
  } catch (error) {
    try { await connection.query("ROLLBACK"); } catch { discard = true; }
    const code = (error as { code?: string }).code;
    if (code === "40001")
      throw new DashboardError("conflict", "A versão ativa mudou. Recarregue a base antes de publicar.");
    if (code === "23505")
      throw new DashboardError("identity", "O identificador da transferência já foi utilizado.");
    if (code === "42501")
      throw new DashboardError("forbidden", "Sua sessão não tem permissão para esta transferência.");
    throw new DashboardError("publication", "A operação de publicação não foi confirmada.");
  } finally {
    connection.release(discard);
  }
}
