import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { toJSON } from "seroval";

const origin = "https://comercial-preview.example.invalid";
const central = "https://central-preview.example.invalid/api/internal/commercial-entitlement";
const store = "https://sessions-preview.example.invalid/";
const supabase = "https://supabase-preview.example.invalid";
const publicSupabase = "https://supabase-public.example.invalid";
const tenantId = "11111111-1111-4111-8111-111111111111";
const objectId = "33333333-3333-4333-8333-333333333333";
const importId = "44444444-4444-4444-8444-444444444444";
const handle = "F".repeat(43);
const handleHash = createHash("sha256").update(handle).digest("hex");
const session = { tenantId, objectId, expiresAt: Date.now() + 60000 };
const { privateKey } = generateKeyPairSync("ed25519");

Object.assign(process.env, {
  COMMERCIAL_AUTH_MODE: "preview",
  VERCEL_ENV: "preview",
  COMMERCIAL_PREVIEW_ORIGIN: origin,
  COMMERCIAL_ENTRA_TENANT_ID: tenantId,
  COMMERCIAL_ENTRA_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
  COMMERCIAL_ENTRA_CLIENT_SECRET: "synthetic-fixture",
  COMMERCIAL_SESSION_STORE_URL: store,
  COMMERCIAL_SESSION_STORE_TOKEN: "synthetic-fixture",
  CENTRAL_BI_ENTITLEMENT_URL: central,
  CENTRAL_BI_ASSERTION_KEY_ID: "preview-test",
  CENTRAL_BI_ASSERTION_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
  COMMERCIAL_PREVIEW_SUPABASE_URL: supabase,
  COMMERCIAL_PREVIEW_SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable",
  SUPABASE_URL: publicSupabase,
  SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable",
});

let allowed = true;
const requests = [];
globalThis.fetch = async (input, options) => {
  const url = String(input);
  requests.push(url);
  if (url === store) {
    const [command, key] = JSON.parse(options.body);
    assert.equal(command, "GET");
    assert.ok(key.endsWith(":session:" + handleHash));
    return Response.json({ result: JSON.stringify(session) });
  }
  if (url === central) return Response.json({ allowed });
  if (
    [supabase, publicSupabase].some((base) => url === base + "/rest/v1/rpc/dashboard_read_manifest")
  ) {
    return Response.json({
      access: true,
      isAdmin: false,
      manifest: { import: { id: importId }, bytes: 4000000 },
    });
  }
  if (url === supabase + "/rest/v1/rpc/dashboard_read_page") {
    return Response.json({ rows: [{ rep: "MARCADOR-SINTETICO-PAGINA" }], nextOffset: 1 });
  }
  throw new Error("A suíte intercepta toda saída do servidor em homologação.");
};

const output = new URL("../.vercel/output/functions/__server.func/", import.meta.url);
const { default: handler } = await import(new URL("index.mjs", output));
const ssr = new URL("_ssr/", output);

async function serverFunction(filePrefix, name) {
  const file = (await readdir(ssr)).find((entry) => entry.startsWith(filePrefix));
  const content = await readFile(new URL(file, ssr), "utf8");
  const match = content.match(new RegExp('id: "([a-f0-9]+)",\\s*name: "' + name + '"'));
  assert.ok(match, "Função ausente do pacote de servidor: " + name);
  return "/_serverFn/" + match[1];
}

async function request(path, authenticated = false, serverFn = false) {
  const headers = new Headers();
  if (authenticated) headers.set("Cookie", "__Host-comercial-session=" + handle);
  if (serverFn) headers.set("x-tsr-serverFn", "true");
  return handler.fetch(new Request(origin + path, { headers }));
}

const landing = await request("/");
assert.equal(landing.status, 200);
assert.match(landing.headers.get("cache-control"), /private, no-store/);
assert.match(await landing.text(), /Entrar com Microsoft/);
assert.deepEqual(requests, []);

const statePath = await serverFunction("dashboard.functions-", "getDashboardState");
const pagePath = await serverFunction("dashboard-upload.functions-", "readSharedPage");
const page =
  pagePath +
  "?payload=" +
  encodeURIComponent(
    JSON.stringify(
      toJSON({
        data: { importId, kind: "faturamento", offset: 0 },
      }),
    ),
  );

assert.match(await (await request(statePath, false, true)).text(), /corporate_login/);
assert.match(await (await request(page, false, true)).text(), /corporate_login/);
assert.deepEqual(requests, []);

allowed = false;
assert.match(await (await request(statePath, true, true)).text(), /corporate_denied/);
assert.match(await (await request(page, true, true)).text(), /corporate_denied/);
assert.equal(
  requests.some((url) => url.startsWith(supabase)),
  false,
);

allowed = true;
const state = await (await request(statePath, true, true)).text();
assert.match(state, new RegExp(importId));
allowed = false;
assert.match(await (await request(page, true, true)).text(), /corporate_denied/);
assert.equal(
  requests.some((url) => url.endsWith("/dashboard_read_page")),
  false,
);
allowed = true;
assert.match(await (await request(page, true, true)).text(), /MARCADOR-SINTETICO-PAGINA/);

session.expiresAt = 1;
assert.match(await (await request(page, true, true)).text(), /corporate_login/);
assert.equal((await request("/api/corporate-auth/callback")).status, 400);
process.env.VERCEL_ENV = "production";
assert.equal((await request("/api/corporate-auth/login")).status, 404);
requests.length = 0;
assert.match(await (await request(statePath, false, true)).text(), new RegExp(importId));
assert.deepEqual(requests, [publicSupabase + "/rest/v1/rpc/dashboard_read_manifest"]);
console.log("Build Vercel verificado localmente: SSR, leitura, paginação e callback.");
