import type { Locale } from "./locale";

/**
 * Langue du lecteur, lisible des deux côtés : ce module n'importe rien de serveur, si bien que
 * les phrases partagées avec l'interface (lib/billing/limits-text) peuvent s'en servir.
 * Côté serveur, lib/i18n/context branche ici la langue portée par la requête ; dans le
 * navigateur, rien n'est branché et l'appelant passe la langue de useLocale().
 */
let resolve: () => Locale | undefined = () => undefined;

export function currentLocale(): Locale {
  return resolve() ?? "fr";
}

export function setLocaleResolver(fn: () => Locale | undefined): void {
  resolve = fn;
}
