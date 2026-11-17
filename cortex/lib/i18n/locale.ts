/**
 * LANGUES DE L'INTERFACE — module pur, partagé par le serveur, le client et les tests.
 *
 * Ordre de résolution (décision de Ben, 17/11/2026) : la préférence du compte, sinon le
 * choix posé par le sélecteur de langue (cookie, utile avant la connexion et sans auth),
 * sinon `Accept-Language`, sinon l'anglais. La langue d'un examen est une autre affaire :
 * elle suit le cours (lib/exam-language), jamais l'interface.
 */

export const LOCALES = ["fr", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Cookie posé par le sélecteur de langue et recopié depuis le compte (cf. LocaleSync). */
export const LOCALE_COOKIE = "cortex_locale";

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

/**
 * Première langue livrée d'un en-tête Accept-Language, par qualité décroissante (à
 * qualité égale, l'ordre d'écriture). Seule la langue principale compte (`fr-CH` → `fr`).
 * null quand aucune langue livrée n'est acceptée : le repli appartient à l'appelant.
 */
export function negotiateLocale(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked: Array<{ lang: string; q: number; i: number }> = [];
  header.split(",").forEach((part, i) => {
    const [tag, ...params] = part.trim().split(";");
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split("=");
      if (k === "q") q = v !== undefined && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
    }
    if (!tag || Number.isNaN(q) || q <= 0) return;
    ranked.push({ lang: tag.trim().toLowerCase().split("-")[0], q, i });
  });
  ranked.sort((a, b) => b.q - a.q || a.i - b.i);
  return ranked.map((r) => r.lang).find(isLocale) ?? null;
}

export type LocaleSignals = {
  /** users.locale (null : jamais choisi). */
  account?: string | null;
  /** Valeur du cookie cortex_locale. */
  cookie?: string | null;
  acceptLanguage?: string | null;
};

export function resolveLocale(s: LocaleSignals): Locale {
  if (isLocale(s.account)) return s.account;
  if (isLocale(s.cookie)) return s.cookie;
  return negotiateLocale(s.acceptLanguage) ?? DEFAULT_LOCALE;
}

/** Valeur d'un cookie dans un en-tête `Cookie` brut (routes API, sans next/headers). */
export function cookieValue(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null; // %E0 isolé : cookie forgé, ignoré comme toute valeur inconnue
    }
  }
  return null;
}

/** Nom de chaque langue DANS cette langue (« English » reste « English » dans une interface
 *  française) : c'est ce qu'on cherche du regard quand on ne lit pas la langue affichée. */
export const LOCALE_NAMES: Record<Locale, string> = { fr: "Français", en: "English" };

/** Cookie de langue écrit par le navigateur (sélecteur, recopie de la langue du compte). */
export function localeCookie(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}
