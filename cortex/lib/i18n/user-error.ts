import { currentLocale } from "./current";
import type { Locale } from "./locale";
import { MESSAGES, type Messages } from "./messages";
import { translator } from "./translate";

/**
 * ERREUR À MONTRER, sans langue : un code stable (clé de `errors.*` dans messages/*.json) et
 * ses paramètres ICU. La phrase est fabriquée au dernier moment, dans la langue de celui qui
 * la lit : la requête pour l'API, l'anglais pour le connecteur MCP, le compte pour un e-mail.
 * Le code part aussi dans la réponse : un client (l'interface, un script) peut s'y fier sans
 * analyser une phrase.
 */
export type ErrorCode = keyof Messages["errors"];
export type ErrorParams = Record<string, string | number>;
export type UserError = { code: ErrorCode; params?: ErrorParams };
export type FileUserError = UserError & { file: string };

export function userError(code: ErrorCode, params?: ErrorParams): UserError {
  return params ? { code, params } : { code };
}

export function isUserError(v: unknown): v is UserError {
  return !!v && typeof v === "object" && typeof (v as { code?: unknown }).code === "string"
    && Object.hasOwn(MESSAGES.fr.errors, (v as { code: string }).code);
}

export function errorText(locale: Locale, e: UserError): string {
  const t = translator(locale) as unknown as (key: string, values?: ErrorParams) => string;
  return t(`errors.${e.code}`, e.params);
}

/**
 * Exception qui porte une erreur à montrer et son statut HTTP. Son `message` est la phrase dans
 * la langue du contexte (lib/i18n/context : celle de la requête, français hors requête) ; la
 * route la renvoie par apiError, dans la langue du lecteur.
 */
export class UserFacingError extends Error implements UserError {
  readonly code: ErrorCode;
  readonly params?: ErrorParams;
  readonly status: number;
  constructor(e: UserError, status = 400) {
    super(errorText(currentLocale(), e));
    this.name = "UserFacingError";
    this.code = e.code;
    if (e.params) this.params = e.params;
    this.status = status;
  }
}

/**
 * Refus rendu (pas jeté) par une garde de lib/ : statut HTTP, code, paramètres, et `error`, la
 * phrase dans la langue du contexte, gardée pour les journaux et les appelants d'avant les
 * codes. Une route le passe tel quel à `apiError(req, r, r.status)`.
 */
export type Refusal<S extends number = number> = UserError & { status: S; error: string };

export function refusal<S extends number>(status: S, code: ErrorCode, params?: ErrorParams): Refusal<S> {
  const e = userError(code, params);
  return { status, ...e, error: errorText(currentLocale(), e) };
}

/** Transforme une exception montrable en refus rendu, sans perdre son code ni ses paramètres. */
export function refusalFrom(e: UserFacingError): Refusal {
  return { status: e.status, code: e.code, ...(e.params ? { params: e.params } : {}), error: e.message };
}

/** Ajoute le nom du fichier aux erreurs dont le message ICU prévoit le paramètre `file`. */
export function errorForFile(e: UserError, file: string): FileUserError {
  return { code: e.code, ...(e.params ? { params: e.params } : {}), file };
}
