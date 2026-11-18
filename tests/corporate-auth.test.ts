import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import type { CustomFetch } from "openid-client";
import { corporateAuthPaths } from "../src/lib/corporate/access";
import {
  corporateAuthResponse,
  corporatePreviewEnabled,
  createCorporateAuth,
  requireCorporateRead,
} from "../src/lib/corporate/auth.server";
import { dashboardConfig } from "../src/lib/dashboard/shared.server";

const tenant = "11111111-1111-4111-8111-111111111111";
const client = "22222222-2222-4222-8222-222222222222";
const object = "33333333-3333-4333-8333-333333333333";
const origin = "https://comercial-preview.example.invalid";
const endpoint = "https://central-preview.example.invalid/api/internal/commercial-entitlement";
const redis = "https://sessions-preview.example.invalid/";
const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
const entraEndpoint = `https://login.microsoftonline.com/${tenant}`;
const applicationKeys = generateKeyPairSync("ed25519");
const entraKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

function setup() {
  const env = {
    VERCEL_ENV: "preview",
    COMMERCIAL_AUTH_MODE: "preview",
    COMMERCIAL_PREVIEW_ORIGIN: origin,
    COMMERCIAL_ENTRA_TENANT_ID: tenant,
    COMMERCIAL_ENTRA_CLIENT_ID: client,
    COMMERCIAL_ENTRA_CLIENT_SECRET: "synthetic-fixture",
    COMMERCIAL_SESSION_STORE_URL: redis,
    COMMERCIAL_SESSION_STORE_TOKEN: "synthetic-fixture",
    CENTRAL_BI_ENTITLEMENT_URL: endpoint,
    CENTRAL_BI_ASSERTION_PRIVATE_KEY: applicationKeys.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    CENTRAL_BI_ASSERTION_KEY_ID: "preview-test",
  };
  const state = {
    allowed: true,
    centralUnavailable: false,
    token: "",
    checks: 0,
    tokenRequests: 0,
  };
  const records = new Map<string, string>();

  const entraFetch: CustomFetch = async (url, options) => {
    if (url.includes("/.well-known/openid-configuration")) {
      return Response.json({
        issuer,
        authorization_endpoint: entraEndpoint + "/oauth2/v2.0/authorize",
        token_endpoint: entraEndpoint + "/oauth2/v2.0/token",
        jwks_uri: entraEndpoint + "/discovery/v2.0/keys",
        id_token_signing_alg_values_supported: ["RS256"],
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      });
    }
    if (url.endsWith("/keys")) {
      return Response.json({
        keys: [
          { ...entraKeys.publicKey.export({ format: "jwk" }), kid: "synthetic", alg: "RS256" },
        ],
      });
    }
    state.tokenRequests++;
    const params = new URLSearchParams(String(options.body));
    expect(params.get("redirect_uri")).toBe(origin + corporateAuthPaths.callback);
    expect(params.get("code_verifier")).toMatch(/^[\w-]{43}$/);
    return Response.json({
      id_token: state.token,
      access_token: "synthetic",
      token_type: "Bearer",
    });
  };

  const dependencies: typeof fetch = async (input, options) => {
    if (String(input) === redis) {
      const [command, key, value] = JSON.parse(String(options?.body));
      expect(options?.redirect).toBe("error");
      const stored = records.get(key) ?? null;
      if (command === "SET") {
        expect(stored).toBeNull();
        records.set(key, value);
        return Response.json({ result: "OK" });
      }
      if (command === "GETDEL" || command === "DEL") records.delete(key);
      return Response.json({ result: command === "DEL" ? Number(stored !== null) : stored });
    }

    expect(String(input)).toBe(endpoint);
    state.checks++;
    expect(options?.method).toBe("POST");
    expect(options?.redirect).toBe("error");
    const assertion = new Headers(options?.headers).get("Authorization")!.split(" ")[1];
    const [header, payload, signature] = assertion.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "EdDSA",
      typ: "JWT",
      kid: "preview-test",
    });
    expect(
      verify(
        null,
        Buffer.from(`${header}.${payload}`),
        applicationKeys.publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toMatchObject({
      iss: "movopainelcomercial",
      aud: endpoint,
      tid: tenant,
      oid: object,
      dashboard: "painel-comercial-r1",
      permission: "dashboard:read",
    });
    expect(claims.exp - claims.iat).toBe(30);
    expect(claims.jti).toBeString();
    return state.centralUnavailable
      ? new Response(null, { status: 503 })
      : Response.json({ allowed: state.allowed });
  };

  const auth = createCorporateAuth(env, dependencies, entraFetch);
  async function start(overrides: object = {}, validSignature = true) {
    const login = await auth.handleRoute(
      new Request(origin + corporateAuthPaths.login + "?next=https://unexpected.invalid"),
    );
    expect(login.status).toBe(303);
    const location = new URL(login.headers.get("location")!);
    expect(location.origin).toBe("https://login.microsoftonline.com");
    expect(location.searchParams.get("redirect_uri")).toBe(origin + corporateAuthPaths.callback);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const cookie = login.headers.getSetCookie()[0];
    expect(cookie).toMatch(
      /__Host-comercial-login=[\w-]{43}; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax; Secure/,
    );
    const callback = new URL(origin + corporateAuthPaths.callback);
    callback.searchParams.set("code", "synthetic");
    callback.searchParams.set("state", location.searchParams.get("state")!);
    const now = Math.floor(Date.now() / 1000);
    const signed = [
      encode({ alg: "RS256", kid: "synthetic" }),
      encode({
        iss: issuer,
        aud: client,
        sub: "synthetic",
        tid: tenant,
        oid: object,
        iat: now,
        exp: now + 60,
        nonce: location.searchParams.get("nonce"),
        ...overrides,
      }),
    ].join(".");
    const signature = validSignature
      ? sign("RSA-SHA256", Buffer.from(signed), entraKeys.privateKey).toString("base64url")
      : "invalid-signature";
    state.token = `${signed}.${signature}`;
    return { callback, cookie: cookie.split(";")[0] };
  }

  const request = (cookie = "", path = "/") =>
    new Request(origin + path, { headers: { Cookie: cookie } });
  async function finish() {
    const attempt = await start();
    const result = await auth.handleRoute(
      new Request(attempt.callback, { headers: { Cookie: attempt.cookie } }),
    );
    const session = result.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-comercial-session="));
    return { ...attempt, result, session: session?.split(";")[0] };
  }
  return { auth, start, finish, state, request, records };
}

test("Preview usa PKCE, callback fixo e sessão opaca de uso próprio", async () => {
  const { auth, finish, state, request, records } = setup();
  await expect(auth.authorize(request())).rejects.toMatchObject({ code: "corporate_login" });
  expect(state.checks).toBe(0);
  const { result, session, callback, cookie } = await finish();
  expect(result.status).toBe(303);
  expect(result.headers.get("location")).toBe(origin + "/");
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(result.headers.getSetCookie().join("\n")).toContain(
    "Max-Age=3600; HttpOnly; SameSite=Lax; Secure",
  );
  expect(JSON.stringify([...records])).not.toContain(session!.split("=")[1]);
  await expect(auth.authorize(request(session))).resolves.toBeUndefined();
  expect(state.checks).toBe(2);
  expect(
    (await auth.handleRoute(new Request(callback, { headers: { Cookie: cookie } }))).status,
  ).toBe(400);
  expect(state.tokenRequests).toBe(1);
});

test("nega host, state, assinatura, nonce, audience, expiração e identidade inválidos", async () => {
  const { auth, start, state } = setup();
  expect(
    (
      await auth.handleRoute(
        new Request("https://other.example.invalid" + corporateAuthPaths.login),
      )
    ).status,
  ).toBe(403);
  const invalid = await start();
  invalid.callback.searchParams.set("state", "unexpected");
  expect(
    (await auth.handleRoute(new Request(invalid.callback, { headers: { Cookie: invalid.cookie } })))
      .status,
  ).toBe(400);
  expect(state.tokenRequests).toBe(0);
  expect(
    (
      await auth.handleRoute(new Request(invalid.callback, { headers: { Cookie: invalid.cookie } }))
    ).headers.getSetCookie(),
  ).toEqual([]);
  for (const [claims, validSignature] of [
    [{ oid: undefined }, true],
    [{ tid: object }, true],
    [{ nonce: "invalid" }, true],
    [{ aud: object }, true],
    [{ exp: 1 }, true],
    [{}, false],
  ] as const) {
    const { callback, cookie } = await start(claims, validSignature);
    const response = await auth.handleRoute(new Request(callback, { headers: { Cookie: cookie } }));
    expect(response.status).toBe(401);
  }
  expect(state.checks).toBe(0);
});

test("revalida concessão, expiração e logout e bloqueia indisponibilidade", async () => {
  const { auth, finish, state, request, records } = setup();
  state.allowed = false;
  const denied = await finish();
  expect(denied.result.status).toBe(403);
  expect(denied.session).toBeUndefined();
  state.allowed = true;
  let { session } = await finish();
  state.allowed = false;
  await expect(auth.authorize(request(session))).rejects.toMatchObject({
    code: "corporate_denied",
  });
  state.allowed = true;
  state.centralUnavailable = true;
  await expect(auth.authorize(request(session))).rejects.toThrow(
    "Consulta de concessão indisponível.",
  );
  state.centralUnavailable = false;
  for (const [key, record] of records)
    records.set(key, JSON.stringify({ ...JSON.parse(record), expiresAt: 1 }));
  await expect(auth.authorize(request(session))).rejects.toMatchObject({ code: "corporate_login" });

  ({ session } = await finish());
  const logout = (source: string) =>
    new Request(origin + corporateAuthPaths.logout, {
      method: "POST",
      headers: { Origin: source, Cookie: session! },
    });
  expect((await auth.handleRoute(logout("https://other.example.invalid"))).status).toBe(403);
  await expect(auth.authorize(request(session))).resolves.toBeUndefined();
  expect((await auth.handleRoute(logout(origin))).status).toBe(303);
  await expect(auth.authorize(request(session))).rejects.toMatchObject({ code: "corporate_login" });
});

const environment = { ...process.env };
afterEach(() => {
  for (const name of [
    "COMMERCIAL_AUTH_MODE",
    "VERCEL_ENV",
    "COMMERCIAL_PREVIEW_ORIGIN",
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "COMMERCIAL_PREVIEW_SUPABASE_URL",
    "COMMERCIAL_PREVIEW_SUPABASE_PUBLISHABLE_KEY",
  ]) {
    const previous = environment[name];
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("modo público preservado e Preview incompleto falha fechado", async () => {
  const route = new Request(origin + corporateAuthPaths.login);
  expect(corporatePreviewEnabled({})).toBe(false);
  process.env.COMMERCIAL_AUTH_MODE = "preview";
  process.env.VERCEL_ENV = "production";
  await expect(requireCorporateRead(route)).resolves.toBe(false);
  expect((await corporateAuthResponse(route))?.status).toBe(404);
  process.env.VERCEL_ENV = "preview";
  delete process.env.COMMERCIAL_PREVIEW_ORIGIN;
  await expect(requireCorporateRead(route)).rejects.toMatchObject({
    code: "corporate_unavailable",
  });
  expect((await corporateAuthResponse(route))?.status).toBe(503);
});

test("Preview exige um Supabase isolado sem fallback para a configuração pública", () => {
  process.env.COMMERCIAL_AUTH_MODE = "preview";
  process.env.VERCEL_ENV = "preview";
  process.env.SUPABASE_URL = "https://original.example.invalid";
  process.env.SUPABASE_PUBLISHABLE_KEY = "synthetic-public-key";
  delete process.env.COMMERCIAL_PREVIEW_SUPABASE_URL;
  expect(dashboardConfig()).toBeNull();
  process.env.COMMERCIAL_PREVIEW_SUPABASE_PUBLISHABLE_KEY = "synthetic-preview-key";
  process.env.COMMERCIAL_PREVIEW_SUPABASE_URL = process.env.SUPABASE_URL;
  expect(() => dashboardConfig()).toThrow("Supabase isolado");
  process.env.COMMERCIAL_PREVIEW_SUPABASE_URL = "https://yvsuaterzpekenlyzaoa.supabase.co";
  expect(() => dashboardConfig()).toThrow("Supabase isolado");
  process.env.COMMERCIAL_PREVIEW_SUPABASE_URL = "https://isolado.example.invalid";
  expect(dashboardConfig()).toEqual({
    url: "https://isolado.example.invalid",
    publishableKey: "synthetic-preview-key",
  });
});
