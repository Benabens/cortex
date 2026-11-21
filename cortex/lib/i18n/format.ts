import { type Locale } from "./locale";
import { APP_TIME_ZONE } from "./messages";

/**
 * Formats de l'interface (nombres, prix, dates), au lieu des `fr-FR` / `fr-CH` écrits en dur.
 * `en` → en-GB : jour avant le mois et horloge de 24 h, comme le public européen de l'app.
 * Toutes les heures sont celles de Zurich (APP_TIME_ZONE), jamais celle du serveur ou du
 * navigateur : un rappel « avant 14:00 » veut dire la même chose pour tout le monde.
 */
const INTL_TAG: Record<Locale, string> = { fr: "fr-FR", en: "en-GB" };

/** ISO ou date SQL (« 2026-09-26 10:00:00 », sans fuseau = UTC, comme la base l'écrit). */
function toDate(v: string | number | Date): Date {
  if (v instanceof Date || typeof v === "number") return new Date(v);
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T12:00:00Z`); // jour seul : midi, aucun basculement
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return new Date(`${s.replace(" ", "T")}Z`);
  return new Date(s);
}

export function fmt(locale: Locale) {
  const tag = INTL_TAG[locale];
  const tz = APP_TIME_ZONE;
  const dated = (v: string | number | Date, opts: Intl.DateTimeFormatOptions) => {
    const d = toDate(v);
    return Number.isNaN(d.getTime()) ? String(v) : new Intl.DateTimeFormat(tag, { timeZone: tz, ...opts }).format(d);
  };
  return {
    tag,
    number: (n: number, maxFraction = 2) => new Intl.NumberFormat(tag, { maximumFractionDigits: maxFraction }).format(n),
    /** « 14,90 € », « 119 € » : pas de décimales inutiles. */
    price: (amount: number, currency: string) => {
      const cents = Math.round(amount * 100) % 100 !== 0;
      return new Intl.NumberFormat(tag, { style: "currency", currency, minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 }).format(amount);
    },
    /** Montant d'un document de paiement (reçu, facture), en unités mineures, toujours au centime : « 9,00 € », « €9.00 ». */
    money: (cents: number, currency: string) =>
      new Intl.NumberFormat(tag, { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100),
    /** « 17 novembre 2026 » ; `short` : « 17 nov. ». */
    date: (v: string | number | Date, style: "long" | "short" = "long") =>
      dated(v, style === "long" ? { day: "numeric", month: "long", year: "numeric" } : { day: "numeric", month: "short" }),
    time: (v: string | number | Date) => dated(v, { hour: "2-digit", minute: "2-digit", hour12: false }),
    dateTime: (v: string | number | Date) => dated(v, { dateStyle: "long", timeStyle: "short", hour12: false }),
  };
}

export type Fmt = ReturnType<typeof fmt>;
