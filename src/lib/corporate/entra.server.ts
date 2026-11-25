import * as oidc from "openid-client";
import { CorporateFailure } from "./diagnostics";
import { z } from "zod";

export const directoryId = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export const identitySchema = z.object({ tenantId: directoryId, objectId: directoryId });
export type CorporateIdentity = z.infer<typeof identitySchema>;

export const attemptSchema = z.object({
  state: z.string().min(1),
  nonce: z.string().min(1),
  codeVerifier: z.string().min(43),
});
export type LoginAttempt = z.infer<typeof attemptSchema>;

export function commercialEntra(
  settings: { tenantId: string; clientId: string; clientSecret: string; callback: URL },
  fetcher?: oidc.CustomFetch,
) {
  const fetchEntra: oidc.CustomFetch = async (url, options) => {
    try {
      if (fetcher) return await fetcher(url, options);
      const body = options.body instanceof Uint8Array ? new Uint8Array(options.body) : options.body;
      return await fetch(url, { ...options, body });
    } catch {
      const stage = url.includes("/.well-known/openid-configuration") ? "entra_discovery" : "entra_callback";
      throw new CorporateFailure(stage, "unreachable");
    }
  };

  function upstreamFailure(stage: "entra_discovery" | "entra_callback", error: unknown) {
    if (error instanceof CorporateFailure) return error;
    if (error instanceof oidc.ClientError) {
      if (error.cause instanceof CorporateFailure) return error.cause;
      if (error.cause instanceof Response)
        return new CorporateFailure(stage, "http_error", { upstreamStatus: error.cause.status });
      if (["OAUTH_TIMEOUT", "OAUTH_ABORT"].includes(error.code ?? ""))
        return new CorporateFailure(stage, "unreachable");
    }
    if (stage === "entra_discovery") return new CorporateFailure(stage, "invalid_response");
  }

  let discovery: Promise<oidc.Configuration> | undefined;
  function configuration() {
    discovery ??= oidc
      .discovery(
        new URL(`https://login.microsoftonline.com/${settings.tenantId}/v2.0`),
        settings.clientId,
        { id_token_signed_response_alg: "RS256" },
        oidc.ClientSecretPost(settings.clientSecret),
        { [oidc.customFetch]: fetchEntra, execute: [oidc.enableNonRepudiationChecks] },
      )
      .catch((error: unknown) => {
        discovery = undefined;
        throw upstreamFailure("entra_discovery", error);
      });
    return discovery;
  }

  return {
    async start() {
      const attempt: LoginAttempt = {
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
        codeVerifier: oidc.randomPKCECodeVerifier(),
      };
      const url = oidc.buildAuthorizationUrl(await configuration(), {
        redirect_uri: settings.callback.href,
        scope: "openid profile",
        state: attempt.state,
        nonce: attempt.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(attempt.codeVerifier),
        code_challenge_method: "S256",
      });
      return { url, attempt };
    },

    async finish(callback: URL, attempt: LoginAttempt): Promise<CorporateIdentity> {
      const config = await configuration();
      const tokens = await oidc.authorizationCodeGrant(config, callback, {
        expectedState: attempt.state,
        expectedNonce: attempt.nonce,
        pkceCodeVerifier: attempt.codeVerifier,
        idTokenExpected: true,
      }).catch((error: unknown) => {
        if (error instanceof oidc.ResponseBodyError && error.error === "invalid_client")
          throw new CorporateFailure("entra_callback", "client_rejected", { upstreamStatus: error.status });
        throw upstreamFailure("entra_callback", error) ?? error;
      });
      const claims = tokens.claims();
      const identity = identitySchema.parse({ tenantId: claims?.tid, objectId: claims?.oid });
      if (identity.tenantId !== settings.tenantId) throw new Error("Tenant Entra inválido.");
      return identity;
    },
  };
}
