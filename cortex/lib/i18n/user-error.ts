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
 * Exception qui porte une erreur à montrer et son statut HTTP. Son `message` est la phrase
 * française (journaux, anciens appelants) ; la route la renvoie dans la langue du lecteur.
 */
export class UserFacingError extends Error implements UserError {
  readonly code: ErrorCode;
  readonly params?: ErrorParams;
  readonly status: number;
  constructor(e: UserError, status = 400) {
    super(errorText("fr", e));
    this.name = "UserFacingError";
    this.code = e.code;
    if (e.params) this.params = e.params;
    this.status = status;
  }
}

/**
 * Refus rendu (pas jeté) par une garde de lib/ : statut HTTP, code, paramètres, et `error`, la
 * phrase française gardée pour les journaux et les appelants d'avant les codes. Une route le
 * passe tel quel à `apiError(req, r, r.status)`.
 */
export type Refusal<S extends number = number> = UserError & { status: S; error: string };

export function refusal<S extends number>(status: S, code: ErrorCode, params?: ErrorParams): Refusal<S> {
  const e = userError(code, params);
  return { status, ...e, error: errorText("fr", e) };
}
