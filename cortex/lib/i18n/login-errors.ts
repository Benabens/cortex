import type { useTranslations } from "use-intl/react";

/**
 * Messages clairs par code d'erreur NextAuth/magic-link (cause + quoi faire), namespace
 * "login" — partagés par /login (LoginCard) et /verify-request (VerifyRequestCard), les
 * deux points d'entrée où un code d'erreur de connexion peut apparaître.
 */
export function loginErrorMessage(code: string, t: ReturnType<typeof useTranslations<"login">>): string {
  switch (code) {
    case "AccessDenied":
      return t("errorAccessDenied");
    case "Verification":
      return t("errorVerification");
    case "OAuthAccountNotLinked":
      return t("errorOAuthAccountNotLinked");
    case "CredentialsSignin":
      return t("errorCredentialsSignin");
    case "rate_limited":
      return t("errorRateLimited");
    case "EmailWait":
      return t("errorEmailWait");
    case "EmailDay":
      return t("errorEmailDay");
    case "EmailIp":
      return t("errorEmailIp");
    case "EmailDisposable":
      return t("errorEmailDisposable");
    case "Configuration":
      return t("errorConfiguration");
    default:
      return t("errorDefault");
  }
}
