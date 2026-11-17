import { NextResponse } from "next/server";
import { cookieValue, LOCALE_COOKIE, resolveLocale, type Locale } from "./locale";
import { errorText, type ErrorCode, type UserError } from "./user-error";

/**
 * Langue d'une requête d'API : le cookie (posé par le sélecteur, et recopié depuis le compte
 * par l'interface), sinon Accept-Language, sinon l'anglais. Pas de lecture en base : une
 * réponse d'erreur ne doit pas dépendre de la disponibilité de la base.
 */
export function requestLocale(req: Request): Locale {
  const h = req.headers;
  return resolveLocale({ cookie: cookieValue(h?.get?.("cookie"), LOCALE_COOKIE), acceptLanguage: h?.get?.("accept-language") });
}

/**
 * Réponse d'erreur de l'API : `{ error, code, params? }`. `error` est la phrase dans la langue
 * de la requête ; `code` et `params` sont stables, quelle que soit la langue.
 */
export function apiError(req: Request, e: ErrorCode | UserError, status?: number, extra?: Record<string, unknown>): NextResponse {
  const err: UserError = typeof e === "string" ? { code: e } : { code: e.code, ...(e.params ? { params: e.params } : {}) };
  const resolvedStatus = status ?? (typeof e === "object" && "status" in e && typeof e.status === "number" ? e.status : 400);
  const file = typeof e === "object" && "file" in e && typeof e.file === "string" ? e.file : null;
  const locale = requestLocale(req);
  const message = errorText(locale, err);
  const params = file ? { ...err.params, file } : err.params;
  const text = file ? withFile(locale, file, message) : message;
  return NextResponse.json({ ...extra, error: text, code: err.code, ...(params ? { params } : {}) }, { status: resolvedStatus });
}

/** « annale.pdf : illisible » / "exam.pdf: unreadable" : l'espace avant les deux-points est français. */
function withFile(locale: Locale, file: string, message: string): string {
  return `${file}${locale === "fr" ? " : " : ": "}${message}`;
}

/** Refus d'un fichier parmi d'autres (import partiel réussi), dans la langue de la requête. */
export function fileErrorText(req: Request, file: string, e: UserError): string {
  const locale = requestLocale(req);
  return withFile(locale, file, errorText(locale, e));
}
