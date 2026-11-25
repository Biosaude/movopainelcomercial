export const corporateAuthPaths = {
  login: "/api/corporate-auth/login",
  callback: "/api/corporate-auth/callback",
  logout: "/api/corporate-auth/logout",
} as const;

export type CorporateAccessCode = "corporate_login" | "corporate_denied" | "corporate_unavailable";

export const corporateAccessMessages: Record<CorporateAccessCode, string> = {
  corporate_login: "Entre com sua conta corporativa para consultar o Dashboard Comercial.",
  corporate_denied: "Sua conta não possui concessão individual para o Dashboard Comercial.",
  corporate_unavailable: "Não foi possível verificar o acesso corporativo. Tente novamente.",
};

export function isCorporateAccessCode(code: string): code is CorporateAccessCode {
  return Object.hasOwn(corporateAccessMessages, code);
}

export class CorporateAccessError extends Error {
  constructor(readonly code: CorporateAccessCode) {
    super(corporateAccessMessages[code]);
  }
}
