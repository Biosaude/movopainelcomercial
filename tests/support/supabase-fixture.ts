// Test-only HTTP Auth/PostgREST fixture, backed by a disposable PostgreSQL container.
// No production URL or credentials are accepted by this fixture.
const container = process.env.DASHBOARD_TEST_CONTAINER;
if (!container?.startsWith("movopainel-sql-"))
  throw new Error("Disposable test container required");
const adminId = "00000000-0000-4000-8000-000000000001";
const visitorId = "00000000-0000-4000-8000-000000000002";
const users = {
  "fixture-admin-token": {
    id: adminId,
    email: "admin@example.test",
    aud: "authenticated",
    role: "authenticated",
  },
  "fixture-visitor-token": {
    id: visitorId,
    email: "visitor@example.test",
    aud: "authenticated",
    role: "authenticated",
  },
};
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
async function sql(statement: string, actor?: string) {
  const environment = { ...process.env };
  for (const name of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ])
    delete environment[name];
  const query = `BEGIN; SET LOCAL ROLE ${actor ? "authenticated" : "anon"}; SET LOCAL request.jwt.claim.sub = ${quote(actor ?? "")}; ${statement}; COMMIT;`;
  const proc = Bun.spawn(
    [
      "docker",
      "--host=unix:///var/run/docker.sock",
      "exec",
      "-i",
      container!,
      "psql",
      "-U",
      "postgres",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=verbose",
    ],
    { env: environment, stdin: new Response(query), stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (status !== 0)
    throw {
      code: error.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1] ?? "fixture_error",
      message: "Test database rejected operation",
    };
  return JSON.parse(output.trim());
}
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "content-type": "application/json",
};
const response = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: cors });
const metrics = {
  snapshotReads: 0,
  manifestReads: 0,
  pageReads: 0,
  publications: 0,
  maxBatchRequestBytes: 0,
  maxPageResponseBytes: 0,
};
let failChunkIndex: number | null = null;
let failReadAfterPublish = false;
let pendingReadFailures = 0;
let failPageOffset: number | null = null;
let denyManagement = false;
Bun.serve({
  hostname: "127.0.0.1",
  port: 54329,
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const token = request.headers.get("authorization")?.replace("Bearer ", "");
    const user = users[token as keyof typeof users];
    try {
      if (url.pathname === "/__test/metrics") return response(metrics);
      if (url.pathname === "/__test/fail-page" && request.method === "POST") {
        failPageOffset = (await request.json()).offset;
        return response({ armed: true });
      }
      if (url.pathname === "/__test/deny-management" && request.method === "POST") {
        denyManagement = (await request.json()).deny;
        return response({ denyManagement });
      }
      if (url.pathname === "/__test/fail-chunk" && request.method === "POST") {
        const body = await request.json();
        failChunkIndex = body.index;
        return response({ armed: true });
      }
      if (url.pathname === "/__test/fail-read-after-publish" && request.method === "POST") {
        failReadAfterPublish = true;
        return response({ armed: true });
      }
      if (url.pathname === "/auth/v1/token") {
        const body = await request.json();
        const key =
          body.email === "admin@example.test" ? "fixture-admin-token" : "fixture-visitor-token";
        if (
          body.password !== "fixture-password" ||
          !["admin@example.test", "visitor@example.test"].includes(body.email)
        )
          return response({ message: "Invalid credentials" }, 400);
        return response({
          access_token: key,
          token_type: "bearer",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: `refresh-${key}`,
          user: users[key],
        });
      }
      if (url.pathname === "/auth/v1/user")
        return user ? response(user) : response({ message: "Invalid JWT", code: "bad_jwt" }, 401);
      if (url.pathname === "/auth/v1/logout") return response({});
      if (token && token !== "test-public-key" && !user)
        return response({ message: "Invalid JWT" }, 401);
      if (url.pathname === "/rest/v1/rpc/dashboard_read_snapshot") {
        metrics.snapshotReads++;
        if (pendingReadFailures > 0) {
          pendingReadFailures--;
          return response(
            { code: "fixture_read_failure", message: "Simulated lost snapshot response" },
            503,
          );
        }
        return response(await sql("SELECT public.dashboard_read_snapshot()", user?.id));
      }
      if (url.pathname === "/rest/v1/rpc/dashboard_read_manifest") {
        metrics.manifestReads++;
        return response(await sql("SELECT public.dashboard_read_manifest()", user?.id));
      }
      if (url.pathname === "/rest/v1/rpc/dashboard_read_page") {
        const body = await request.json();
        metrics.pageReads++;
        if (body.p_offset === failPageOffset) {
          failPageOffset = null;
          return response({ code: "fixture_read_failure", message: "Simulated lost page" }, 503);
        }
        const page = await sql(
          `SELECT public.dashboard_read_page(${quote(body.p_import_id)}::uuid,${quote(body.p_kind)},${quote(String(body.p_offset))}::integer)`,
          user?.id,
        );
        metrics.maxPageResponseBytes = Math.max(
          metrics.maxPageResponseBytes,
          new TextEncoder().encode(JSON.stringify(page)).byteLength,
        );
        return response(page);
      }
      if (url.pathname === "/rest/v1/rpc/dashboard_is_admin")
        return response(
          denyManagement
            ? false
            : await sql("SELECT to_jsonb(public.dashboard_is_admin())", user?.id),
        );
      if (url.pathname === "/rest/v1/dashboard_imports")
        return response(
          await sql(
            "SELECT COALESCE(jsonb_agg(row), '[]'::jsonb) FROM (SELECT id,published_at,file_name,revenue_count,target_count,created_by_label FROM public.dashboard_imports ORDER BY published_at DESC LIMIT 50) row",
            user?.id,
          ),
        );
      if (url.pathname === "/rest/v1/rpc/dashboard_publish") {
        const body = await request.json();
        metrics.publications++;
        const id = await sql(
          `SELECT to_jsonb(public.dashboard_publish(${quote(body.p_request_id)}::uuid, ${body.p_expected_version ? quote(body.p_expected_version) + "::uuid" : "NULL"}, ${quote(body.p_file_name)}, ${quote(JSON.stringify(body.p_faturamento))}::jsonb, ${quote(JSON.stringify(body.p_metas))}::jsonb))`,
          user?.id,
        );
        if (failReadAfterPublish) {
          pendingReadFailures++;
          failReadAfterPublish = false;
        }
        return response(id);
      }
      if (url.pathname === "/rest/v1/rpc/dashboard_upload_begin") {
        const body = await request.json();
        return response(
          await sql(
            `SELECT to_jsonb(public.dashboard_upload_begin(${quote(body.p_request_id)}::uuid,${body.p_expected_version ? quote(body.p_expected_version) + "::uuid" : "NULL"},${quote(body.p_file_name)},${quote(String(body.p_revenue_count))}::integer,${quote(String(body.p_target_count))}::integer,${quote(JSON.stringify(body.p_plan))}::jsonb))`,
            user?.id,
          ),
        );
      }
      if (url.pathname === "/rest/v1/rpc/dashboard_upload_chunk") {
        const body = await request.json();
        metrics.maxBatchRequestBytes = Math.max(
          metrics.maxBatchRequestBytes,
          new TextEncoder().encode(JSON.stringify(body)).byteLength,
        );
        if (body.p_chunk_index === failChunkIndex) {
          failChunkIndex = null;
          return response(
            { code: "fixture_chunk_failure", message: "Simulated intermediate failure" },
            503,
          );
        }
        return response(
          await sql(
            `SELECT to_jsonb(public.dashboard_upload_chunk(${quote(body.p_request_id)}::uuid,${quote(String(body.p_chunk_index))}::integer,${quote(body.p_payload)}))`,
            user?.id,
          ),
        );
      }
      if (url.pathname === "/rest/v1/rpc/dashboard_upload_commit") {
        const body = await request.json();
        metrics.publications++;
        const id = await sql(
          `SELECT to_jsonb(public.dashboard_upload_commit(${quote(body.p_request_id)}::uuid))`,
          user?.id,
        );
        if (failReadAfterPublish) {
          pendingReadFailures++;
          failReadAfterPublish = false;
        }
        return response(id);
      }
      return response({ message: "Fixture route unavailable" }, 404);
    } catch (error) {
      return response(error, 400);
    }
  },
});
console.log("Disposable Supabase fixture listening on port 54329");
