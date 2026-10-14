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
Bun.serve({
  hostname: "127.0.0.1",
  port: 54329,
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const token = request.headers.get("authorization")?.replace("Bearer ", "");
    const user = users[token as keyof typeof users];
    try {
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
      if (url.pathname === "/rest/v1/rpc/dashboard_read_snapshot")
        return response(await sql("SELECT public.dashboard_read_snapshot()", user?.id));
      if (url.pathname === "/rest/v1/rpc/dashboard_is_admin")
        return response(await sql("SELECT to_jsonb(public.dashboard_is_admin())", user?.id));
      if (url.pathname === "/rest/v1/dashboard_imports")
        return response(
          await sql(
            "SELECT COALESCE(jsonb_agg(row), '[]'::jsonb) FROM (SELECT id,published_at,file_name,revenue_count,target_count,created_by_label FROM public.dashboard_imports ORDER BY published_at DESC LIMIT 50) row",
            user?.id,
          ),
        );
      if (url.pathname === "/rest/v1/rpc/dashboard_publish") {
        const body = await request.json();
        return response(
          await sql(
            `SELECT to_jsonb(public.dashboard_publish(${quote(body.p_request_id)}::uuid, ${body.p_expected_version ? quote(body.p_expected_version) + "::uuid" : "NULL"}, ${quote(body.p_file_name)}, ${quote(JSON.stringify(body.p_faturamento))}::jsonb, ${quote(JSON.stringify(body.p_metas))}::jsonb))`,
            user?.id,
          ),
        );
      }
      return response({ message: "Fixture route unavailable" }, 404);
    } catch (error) {
      return response(error, 400);
    }
  },
});
console.log("Disposable Supabase fixture listening on port 54329");
