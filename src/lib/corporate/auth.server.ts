import { createPrivateKey, randomBytes } from "node:crypto";
import type { CustomFetch } from "openid-client";
import { z } from "zod";
import { CorporateAccessError, corporateAccessMessages, corporateAuthPaths } from "./access";
import { attemptSchema, commercialEntra, directoryId, identitySchema } from "./entra.server";
import { entitlementService, sessionStore, type CorporateFetch } from "./dependencies.server";

const attemptSeconds = 600;
const sessionSeconds = 3600;
const storedAttemptSchema = attemptSchema.extend({ expiresAt: z.number().int() });
const sessionSchema = identitySchema.extend({ expiresAt: z.number().int() });
const authPaths: readonly string[] = Object.values(corporateAuthPaths);

export function corporatePreviewEnabled(env = process.env) {
  return env.COMMERCIAL_AUTH_MODE === "preview" && env.VERCEL_ENV !== "production";
}

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  if (!value?.trim()) throw new Error("Configuração corporativa incompleta.");
  return value;
}

function urlSetting(value: string, local = false) {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(local && loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Endereço corporativo inválido.");
  }
  return url;
}

export function createCorporateAuth(
  env: NodeJS.ProcessEnv,
  fetcher: CorporateFetch = fetch,
  entraFetch?: CustomFetch,
) {
  const origin = urlSetting(
    required(env, "COMMERCIAL_PREVIEW_ORIGIN"),
    env.VERCEL_ENV !== "preview",
  );
  const endpoint = urlSetting(required(env, "CENTRAL_BI_ENTITLEMENT_URL"));
  const redis = urlSetting(required(env, "COMMERCIAL_SESSION_STORE_URL"));
  if (
    origin.pathname !== "/" ||
    endpoint.pathname !== "/api/internal/commercial-entitlement" ||
    redis.pathname !== "/"
  ) {
    throw new Error("Caminho corporativo inválido.");
  }
  const key = createPrivateKey(required(env, "CENTRAL_BI_ASSERTION_PRIVATE_KEY"));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Chave corporativa incompatível.");
  const tenantId = directoryId.parse(required(env, "COMMERCIAL_ENTRA_TENANT_ID"));
  const callback = new URL(corporateAuthPaths.callback, origin);
  const entra = commercialEntra(
    {
      tenantId,
      clientId: directoryId.parse(required(env, "COMMERCIAL_ENTRA_CLIENT_ID")),
      clientSecret: required(env, "COMMERCIAL_ENTRA_CLIENT_SECRET"),
      callback,
    },
    entraFetch,
  );
  const check = entitlementService(
    endpoint,
    key,
    required(env, "CENTRAL_BI_ASSERTION_KEY_ID"),
    fetcher,
  );
  const store = sessionStore(
    redis,
    required(env, "COMMERCIAL_SESSION_STORE_TOKEN"),
    origin.origin,
    fetcher,
  );
  const secure = origin.protocol === "https:";
  const sessionCookie = secure ? "__Host-comercial-session" : "comercial-local-session";
  const attemptCookie = secure ? "__Host-comercial-login" : "comercial-local-login";
  const randomHandle = () => randomBytes(32).toString("base64url");

  function cookie(name: string, value: string, maxAge: number) {
    return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  }

  function handle(request: Request, name: string) {
    const values = (request.headers.get("cookie") ?? "")
      .split(";")
      .map((item) => item.trim())
      .filter((item) => item.startsWith(name + "="));
    if (values.length !== 1) return undefined;
    const value = values[0].slice(name.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
  }

  function respond(body: string | null, status: number, location?: URL, cookies: string[] = []) {
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    });
    if (location) headers.set("Location", location.href);
    for (const value of cookies) headers.append("Set-Cookie", value);
    return new Response(body, { status, headers });
  }

  async function authorize(request: Request) {
    if (new URL(request.url).origin !== origin.origin)
      throw new CorporateAccessError("corporate_denied");
    const token = handle(request, sessionCookie);
    const session = token && sessionSchema.safeParse(await store.read("session", token));
    if (
      !session ||
      !session.success ||
      session.data.expiresAt <= Date.now() ||
      session.data.tenantId !== tenantId
    ) {
      throw new CorporateAccessError("corporate_login");
    }
    if (!(await check(session.data))) throw new CorporateAccessError("corporate_denied");
  }

  async function handleRoute(request: Request) {
    const actual = new URL(request.url);
    if (actual.origin !== origin.origin)
      return respond(corporateAccessMessages.corporate_denied, 403);

    if (actual.pathname === corporateAuthPaths.logout) {
      if (request.method !== "POST") return respond(null, 405);
      if (request.headers.get("origin") !== origin.origin) return respond(null, 403);
      const previous = handle(request, sessionCookie);
      if (previous) await store.revoke(previous);
      return respond(null, 303, origin, [
        cookie(sessionCookie, "", 0),
        cookie(attemptCookie, "", 0),
      ]);
    }

    if (request.method !== "GET") return respond(null, 405);
    if (actual.pathname === corporateAuthPaths.login) {
      if (request.headers.get("sec-fetch-site") === "cross-site") return respond(null, 403);
      const { url, attempt } = await entra.start();
      const token = randomHandle();
      await store.save(
        "login",
        token,
        { ...attempt, expiresAt: Date.now() + attemptSeconds * 1000 },
        attemptSeconds,
      );
      return respond(null, 303, url, [cookie(attemptCookie, token, attemptSeconds)]);
    }

    const expiredAttemptCookie = cookie(attemptCookie, "", 0);
    const token = handle(request, attemptCookie);
    const state = actual.searchParams.get("state");
    const invalidAttempt = "Tentativa de autenticação inválida ou expirada.";
    if (!token || !state || actual.searchParams.getAll("state").length !== 1) {
      return respond(invalidAttempt, 400);
    }
    const pending = storedAttemptSchema.safeParse(await store.read("login", token));
    if (!pending.success || pending.data.expiresAt <= Date.now() || pending.data.state !== state) {
      return respond(invalidAttempt, 400);
    }
    const attempt = storedAttemptSchema.safeParse(await store.read("login", token, true));
    if (!attempt.success || attempt.data.expiresAt <= Date.now() || attempt.data.state !== state) {
      return respond(invalidAttempt, 400, undefined, [expiredAttemptCookie]);
    }
    let identity;
    try {
      const responseUrl = new URL(callback);
      responseUrl.search = actual.search;
      identity = await entra.finish(responseUrl, attempt.data);
    } catch {
      return respond("Não foi possível validar o retorno do Microsoft Entra ID.", 401, undefined, [
        expiredAttemptCookie,
      ]);
    }
    if (!(await check(identity))) {
      return respond(corporateAccessMessages.corporate_denied, 403, undefined, [
        expiredAttemptCookie,
      ]);
    }
    const previous = handle(request, sessionCookie);
    if (previous) await store.revoke(previous);
    const session = randomHandle();
    await store.save(
      "session",
      session,
      { ...identity, expiresAt: Date.now() + sessionSeconds * 1000 },
      sessionSeconds,
    );
    return respond(null, 303, origin, [
      expiredAttemptCookie,
      cookie(sessionCookie, session, sessionSeconds),
    ]);
  }

  return { authorize, handleRoute };
}

let services: ReturnType<typeof createCorporateAuth> | undefined;
const corporateAuth = () => (services ??= createCorporateAuth(process.env));

export async function requireCorporateRead(request: Request) {
  if (!corporatePreviewEnabled()) return false;
  try {
    await corporateAuth().authorize(request);
    return true;
  } catch (error) {
    if (error instanceof CorporateAccessError) throw error;
    throw new CorporateAccessError("corporate_unavailable");
  }
}

export async function corporateAuthResponse(request: Request): Promise<Response | undefined> {
  if (!authPaths.includes(new URL(request.url).pathname)) return;
  if (!corporatePreviewEnabled()) return new Response(null, { status: 404 });
  try {
    return await corporateAuth().handleRoute(request);
  } catch {
    return new Response(corporateAccessMessages.corporate_unavailable, {
      status: 503,
      headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
    });
  }
}
