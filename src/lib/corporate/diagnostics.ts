import { corporateAuthPaths } from "./access";

type Operation = "login" | "callback" | "logout" | "access";

export function corporateOperation(path: string): Operation {
  if (path === corporateAuthPaths.login) return "login";
  if (path === corporateAuthPaths.callback) return "callback";
  return path === corporateAuthPaths.logout ? "logout" : "access";
}

export function reportCorporateRejection(operation: Operation, reason: "origin_mismatch" | "cross_site" | "no_entitlement") {
  console.warn(JSON.stringify({ event: "commercial_corporate_auth_denied", operation, reason }));
}

export class CorporateFailure extends Error {
  constructor(
    readonly stage: "configuration" | "entra_discovery" | "entra_start" | "entra_callback" | "redis" | "central",
    readonly reason: "missing" | "invalid" | "unreachable" | "http_error" | "invalid_response" | "command_rejected" |
      "permission_denied" | "authentication_rejected" | "client_rejected",
    readonly details: { setting?: string; command?: "SET" | "GET" | "GETDEL" | "DEL"; upstreamStatus?: number } = {},
  ) {
    super("Serviço de autenticação corporativa indisponível.");
  }
}

export function reportCorporateFailure(
  operation: Operation,
  error: unknown,
) {
  const diagnostic = error instanceof CorporateFailure
    ? { stage: error.stage, reason: error.reason, ...error.details }
    : { stage: "request", reason: "unexpected" };
  console.warn(JSON.stringify({ event: "commercial_corporate_auth_failure", operation, ...diagnostic }));
}
