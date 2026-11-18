import { createHash, randomUUID, sign, type KeyObject } from "node:crypto";
import { z } from "zod";
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
    });
    if (!response.ok) throw new Error("Consulta de concessão indisponível.");
    return z.object({ allowed: z.boolean() }).parse(await response.json()).allowed;
  };
}

export function sessionStore(
  endpoint: URL,
  token: string,
  origin: string,
  fetcher: CorporateFetch,
) {
  const namespace = `comercial:preview:${createHash("sha256").update(origin).digest("hex")}:`;
  async function command(args: (number | string)[]) {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error("Armazenamento corporativo indisponível.");
    const result = z
      .object({ result: z.union([z.string(), z.number(), z.null()]) })
      .parse(await response.json());
    return result.result;
  }
  const key = (kind: "login" | "session", handle: string) =>
    namespace + kind + ":" + createHash("sha256").update(handle).digest("hex");

  return {
    async save(kind: "login" | "session", handle: string, value: object, maxAge: number) {
      if (
        (await command(["SET", key(kind, handle), JSON.stringify(value), "EX", maxAge, "NX"])) !==
        "OK"
      ) {
        throw new Error("Não foi possível persistir a sessão corporativa.");
      }
    },
    async read(kind: "login" | "session", handle: string, consume = false): Promise<unknown> {
      const value = await command([consume ? "GETDEL" : "GET", key(kind, handle)]);
      return typeof value === "string" ? JSON.parse(value) : null;
    },
    async revoke(handle: string) {
      await command(["DEL", key("session", handle)]);
    },
  };
}
