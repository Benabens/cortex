import { AsyncLocalStorage } from "node:async_hooks";
import { setLocaleResolver } from "./current";
import type { Locale } from "./locale";

/**
 * LANGUE DU LECTEUR pour le reste de la chaîne async, comme l'utilisateur courant
 * (db/context) : une garde de lib/ qui compose une phrase (« remise à zéro demain à 01:00 »)
 * l'écrit dans la langue de celui qui la lira. Posée par `useUser(req)` pour l'API (langue de
 * la requête) et par le serveur MCP (anglais).
 *
 * Sans contexte (scripts, worker de jobs, appel direct de lib/) : français, comportement
 * historique de ces chemins. Serveur seulement : le navigateur lit lib/i18n/current.
 */
const localeCtx = new AsyncLocalStorage<Locale>();
setLocaleResolver(() => localeCtx.getStore());

export { currentLocale } from "./current";

export function runWithLocale<T>(locale: Locale, fn: () => T): T {
  return localeCtx.run(locale, fn);
}

export function enterLocale(locale: Locale): Locale {
  localeCtx.enterWith(locale);
  return locale;
}
