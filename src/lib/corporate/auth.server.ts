import { createPrivateKey, randomBytes } from "node:crypto";
import type { CustomFetch } from "openid-client";
import { z } from "zod";
import { CorporateAccessError, corporateAccessMessages, corporateAuthPaths } from "./access";
import { attemptSchema, commercialEntra, directoryId, identitySchema } from "./entra.server";
import { CorporateFailure, corporateOperation, reportCorporateFailure, reportCorporateRejection } from "./diagnostics";
import { entitlementService, sessionStore, type CorporateFetch } from "./dependencies.server";

const attemptSeconds = 600;
const sessionSeconds = 3600;
const storedAttemptSchema = attemptSchema.extend({ expiresAt: z.number().int() });
const sessionSchema = identitySchema.extend({ expiresAt: z.number().int() });
const authPaths: readonly string[] = Object.values(corporateAuthPaths);

export function corporateOriginSetting(env = process.env) {
  return env.VERCEL_ENV === "production" ? "COMMERCIAL_PRODUCTION_ORIGIN" : "COMMERCIAL_PREVIEW_ORIGIN";
}

export function corporatePreviewEnabled(env = process.env) {
  if (env.VERCEL_ENV === "production" || (env.VERCEL === "1" && env.VERCEL_ENV === "preview")) return true;
  return env.COMMERCIAL_AUTH_MODE === "preview";
}

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  if (!value?.trim()) throw new CorporateFailure("configuration", "missing", { setting: name });
  return value;
}

function configuredUrl(env: NodeJS.ProcessEnv, setting: string, path: string, local = false) {
  const url = URL.parse(required(env, setting));
  const loopback = url?.hostname === "localhost" || url?.hostname === "127.0.0.1";
  if (!url || (url.protocol !== "https:" && !(local && loopback && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash || url.pathname !== path) {
    throw new CorporateFailure("configuration", "invalid", { setting });
  }
  return url;
}

export function configuredCorporateOrigin(env: NodeJS.ProcessEnv) {
  return configuredUrl(env, corporateOriginSetting(env), "/", !["preview", "production"].includes(env.VERCEL_ENV ?? ""));
}

// Only the individual URL supplied by the Vercel runtime can recover to the
// configured alias. Session cookies, codes and query strings never cross hosts.
export function previewEntryOrigin(host: string | undefined, env = process.env): URL | undefined {
  if (env.VERCEL !== "1" || env.VERCEL_ENV !== "preview" || !host ||
      host !== env.VERCEL_URL || !/^[a-z0-9-]+\.vercel\.app$/.test(host)) return;
  const canonical = configuredCorporateOrigin(env);
  return canonical.host !== host ? canonical : undefined;
}

function configuredDirectoryId(env: NodeJS.ProcessEnv, setting: string) {
  const id = directoryId.safeParse(required(env, setting));
  if (!id.success) throw new CorporateFailure("configuration", "invalid", { setting });
  return id.data;
}

export function createCorporateAuth(
  env: NodeJS.ProcessEnv,
  fetcher: CorporateFetch = fetch,
  entraFetch?: CustomFetch,
) {
  const origin = configuredCorporateOrigin(env);
  const endpoint = configuredUrl(env, "CENTRAL_BI_ENTITLEMENT_URL", "/api/internal/commercial-entitlement");
  const redis = configuredUrl(env, "COMMERCIAL_SESSION_STORE_URL", "/");
  const keySetting = "CENTRAL_BI_ASSERTION_PRIVATE_KEY";
  const pem = required(env, keySetting);
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
  } catch {
    throw new CorporateFailure("configuration", "invalid", { setting: keySetting });
  }
  const tenantId = configuredDirectoryId(env, "COMMERCIAL_ENTRA_TENANT_ID");
  const callback = new URL(corporateAuthPaths.callback, origin);
  const entra = commercialEntra(
    {
      tenantId,
      clientId: configuredDirectoryId(env, "COMMERCIAL_ENTRA_CLIENT_ID"),
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
    env.COMMERCIAL_CENTRAL_BI_VERCEL_BYPASS_TOKEN,
  );
  const store = sessionStore(
    redis,
    required(env, "COMMERCIAL_SESSION_STORE_TOKEN"),
    origin.origin,
    fetcher,
    env.VERCEL_ENV === "production" ? "production" : "preview",
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
    if (!(await check(session.data))) {
      reportCorporateRejection("access", "no_entitlement");
      throw new CorporateAccessError("corporate_denied");
    }
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
      if (request.headers.get("sec-fetch-site") === "cross-site") {
        reportCorporateRejection("login", "cross_site");
        return respond(null, 403);
      }
      const { url, attempt } = await entra.start().catch((error: unknown) => {
        if (error instanceof CorporateFailure) throw error;
        throw new CorporateFailure("entra_start", "invalid");
      });
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
    } catch (error) {
      if (error instanceof CorporateFailure) throw error;
      reportCorporateFailure("callback", new CorporateFailure("entra_callback", "authentication_rejected"));
      return respond("Não foi possível validar o retorno do Microsoft Entra ID.", 401, undefined, [
        expiredAttemptCookie,
      ]);
    }
    if (!(await check(identity))) {
      reportCorporateRejection("callback", "no_entitlement");
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
    reportCorporateFailure("access", error);
    throw new CorporateAccessError("corporate_unavailable");
  }
}

export async function corporateAuthResponse(request: Request): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (!authPaths.includes(path)) return;
  if (!corporatePreviewEnabled()) return new Response(null, { status: 404 });
  try {
    return await corporateAuth().handleRoute(request);
  } catch (error) {
    reportCorporateFailure(corporateOperation(path), error);
    return new Response(corporateAccessMessages.corporate_unavailable, {
      status: 503,
      headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
    });
  }
}
