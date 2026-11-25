import { createHash, randomUUID, sign, type KeyObject } from "node:crypto";
import { z } from "zod";
import { CorporateFailure } from "./diagnostics";
import type { CorporateIdentity } from "./entra.server";

const dashboard = "painel-comercial-r1";
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

export type CorporateFetch = typeof fetch;

export function entitlementService(
  endpoint: URL,
  key: KeyObject,
  keyId: string,
  fetcher: CorporateFetch,
  vercelBypass?: string,
) {
  return async ({ tenantId, objectId }: CorporateIdentity) => {
    const now = Math.floor(Date.now() / 1000);
    const header = encode({ alg: "EdDSA", typ: "JWT", kid: keyId });
    const claims = encode({
      iss: "movopainelcomercial",
      sub: "movopainelcomercial",
      aud: endpoint.href,
      iat: now,
      exp: now + 30,
      jti: randomUUID(),
      tid: tenantId,
      oid: objectId,
      dashboard,
      permission: "dashboard:read",
    });
    const signed = `${header}.${claims}`;
    const assertion = `${signed}.${sign(null, Buffer.from(signed), key).toString("base64url")}`;
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${assertion}`,
        Accept: "application/json",
        "Cache-Control": "no-store",
        ...(vercelBypass ? { "x-vercel-protection-bypass": vercelBypass } : {}),
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(4000),
    }).catch(() => { throw new CorporateFailure("central", "unreachable"); });
    if (!response.ok) throw new CorporateFailure("central", "http_error", { upstreamStatus: response.status });
    try {
      return z.object({ allowed: z.boolean() }).parse(await response.json()).allowed;
    } catch {
      throw new CorporateFailure("central", "invalid_response");
    }
  };
}

export function sessionStore(
  endpoint: URL,
  token: string,
  origin: string,
  fetcher: CorporateFetch,
  scope: "preview" | "production" = "preview",
) {
  const namespace = `comercial:${scope}:${createHash("sha256").update(origin).digest("hex")}:`;
  async function command(command: "SET" | "GET" | "GETDEL" | "DEL", ...args: (number | string)[]) {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify([command, ...args]),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(4000),
    }).catch(() => { throw new CorporateFailure("redis", "unreachable", { command }); });
    const details = { command, upstreamStatus: response.status };
    if (!response.ok) throw new CorporateFailure("redis", "http_error", details);
    const body: unknown = await response.json().catch(() => {
      throw new CorporateFailure("redis", "invalid_response", details);
    });
    const rejection = z.object({ error: z.string() }).safeParse(body);
    if (rejection.success) {
      const reason = /^(?:ERR )?NOPERM\b/i.test(rejection.data.error) ? "permission_denied" :
        /^(?:ERR )?(?:NOAUTH|WRONGPASS)\b/i.test(rejection.data.error) ? "authentication_rejected" : "command_rejected";
      throw new CorporateFailure("redis", reason, details);
    }
    const result = z.object({ result: z.union([z.string(), z.number(), z.null()]) }).safeParse(body);
    if (!result.success) throw new CorporateFailure("redis", "invalid_response", details);
    return result.data.result;
  }
  const key = (kind: "login" | "session", handle: string) =>
    namespace + kind + ":" + createHash("sha256").update(handle).digest("hex");

  return {
    async save(kind: "login" | "session", handle: string, value: object, maxAge: number) {
      if (
        (await command("SET", key(kind, handle), JSON.stringify(value), "EX", maxAge, "NX")) !==
        "OK"
      ) {
        throw new CorporateFailure("redis", "command_rejected", { command: "SET" });
      }
    },
    async read(kind: "login" | "session", handle: string, consume = false): Promise<unknown> {
      const action = consume ? "GETDEL" : "GET";
      const value = await command(action, key(kind, handle));
      if (typeof value !== "string") return null;
      try {
        return JSON.parse(value);
      } catch {
        throw new CorporateFailure("redis", "invalid_response", { command: action });
      }
    },
    async revoke(handle: string) {
      await command("DEL", key("session", handle));
    },
  };
}
