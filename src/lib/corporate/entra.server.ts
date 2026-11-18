import * as oidc from "openid-client";
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
  let discovery: Promise<oidc.Configuration> | undefined;
  function configuration() {
    discovery ??= oidc
      .discovery(
        new URL(`https://login.microsoftonline.com/${settings.tenantId}/v2.0`),
        settings.clientId,
        { id_token_signed_response_alg: "RS256" },
        oidc.ClientSecretPost(settings.clientSecret),
        { [oidc.customFetch]: fetcher, execute: [oidc.enableNonRepudiationChecks] },
      )
      .catch((error: unknown) => {
        discovery = undefined;
        throw error;
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
      const tokens = await oidc.authorizationCodeGrant(await configuration(), callback, {
        expectedState: attempt.state,
        expectedNonce: attempt.nonce,
        pkceCodeVerifier: attempt.codeVerifier,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      const identity = identitySchema.parse({ tenantId: claims?.tid, objectId: claims?.oid });
      if (identity.tenantId !== settings.tenantId) throw new Error("Tenant Entra inválido.");
      return identity;
    },
  };
}
