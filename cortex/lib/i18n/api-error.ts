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
export function apiError(req: Request, e: ErrorCode | UserError, status: number, extra?: Record<string, unknown>): NextResponse {
  const err: UserError = typeof e === "string" ? { code: e } : { code: e.code, ...(e.params ? { params: e.params } : {}) };
  return NextResponse.json({ ...extra, error: errorText(requestLocale(req), err), code: err.code, ...(err.params ? { params: err.params } : {}) }, { status });
}
