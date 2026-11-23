import { cookieValue, isLocale, LOCALE_COOKIE, type Locale } from "@/lib/i18n/locale";

/** Chemins de l'outil gratuit (pages et API) : servis sans compte, anglais par défaut. */
export function isToolPath(pathname: string): boolean {
  return ["/whats-on-my-exam", "/api/exam-topics"].some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/**
 * Langue d'une requête de l'outil, lue par proxy.ts. `?lang=fr|en` l'emporte (lien de la
 * vitrine, version indexable) et devient le choix du visiteur (cookie) ; sinon le cookie du
 * sélecteur ; sinon l'anglais (décision de Ben : anglais par défaut, comme la vitrine), jamais
 * Accept-Language. `remember` : poser le cookie dans la réponse.
 */
export function toolLocale(langParam: string | null, cookieHeader: string | null): { locale: Locale; remember: boolean } {
  if (isLocale(langParam)) return { locale: langParam, remember: true };
  const cookie = cookieValue(cookieHeader, LOCALE_COOKIE);
  return { locale: isLocale(cookie) ? cookie : "en", remember: false };
}

/** En-tête Cookie de la requête avec la langue de l'outil (les autres cookies gardés). */
export function withLocaleCookie(cookieHeader: string | null, locale: Locale): string {
  const others = (cookieHeader ?? "").split(";").map((s) => s.trim()).filter((s) => s && !s.startsWith(`${LOCALE_COOKIE}=`));
  return [...others, `${LOCALE_COOKIE}=${locale}`].join("; ");
}
