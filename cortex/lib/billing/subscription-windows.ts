/**
 * FENÊTRES DE CRÉDITS D'ABONNEMENT — logique pure, sans base.
 *
 * MENSUEL : les crédits ne viennent QUE d'une facture payée (invoice.paid) ;
 * la fenêtre est la période de facturation. Aucune recharge paresseuse.
 * ANNUEL : une facture par an, mais 20 crédits par MOIS : douze fenêtres
 * mensuelles ancrées sur le début de période (même jour du mois, ramené au
 * dernier jour des mois plus courts), une recharge par fenêtre, jamais après
 * period_end. (L'ancienne recharge au mois CALENDAIRE cumulait avec la
 * facture : ≈ 40 crédits par mois payé, et un mois remboursé se rechargeait.)
 */
export type WindowedSub = {
  plan: string | null;
  period_start: string | null;
  period_end: string | null;
  month_anchor: string | null;
  window_anchor: string | null;
  status: string;
  suspended?: number | boolean | null;
};

const DAY_MS = 86_400_000;

function parse(s: string): Date { return new Date(s.replace(" ", "T") + "Z"); }
function fmt(d: Date): string { return d.toISOString().slice(0, 19).replace("T", " "); }

/** Même jour du mois k mois plus tard, ramené au dernier jour du mois si besoin (31/01 → 28/02 → 31/03). */
export function addMonthsClamped(start: string, k: number): string {
  const d = parse(start);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  const target = new Date(Date.UTC(y, m + k, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return fmt(target);
}

/** Plan annuel : lookup_key/plan « yearly », ou période de plus de 45 jours. */
export function isYearly(sub: Pick<WindowedSub, "plan" | "period_start" | "period_end">): boolean {
  if (/year|annuel/i.test(sub.plan ?? "")) return true;
  if (sub.period_start && sub.period_end) return parse(sub.period_end).getTime() - parse(sub.period_start).getTime() > 45 * DAY_MS;
  return false;
}

/** Début de fenêtre en cours : le plus grand k tel que start + k mois ≤ now. */
export function currentWindowStart(periodStart: string, now: string): string {
  let k = 0;
  let cur = periodStart;
  for (;;) {
    const next = addMonthsClamped(periodStart, k + 1);
    if (next > now) return cur;
    cur = next; k++;
    if (k > 240) return cur;
  }
}

/** Prochaine fenêtre strictement future, ou null si elle tomberait à/après la fin de période. */
export function nextWindowStart(periodStart: string, now: string, periodEnd: string): string | null {
  const cur = currentWindowStart(periodStart, now);
  let k = 1;
  let next = addMonthsClamped(periodStart, k);
  while (next <= cur) { k++; next = addMonthsClamped(periodStart, k); if (k > 240) return null; }
  return next < periodEnd ? next : null;
}

/** Ancre effective d'un abonnement annuel : period_start, sinon (ligne héritée) l'ancre calendaire connue. */
export function anchorOf(sub: WindowedSub): string | null {
  if (sub.period_start) return sub.period_start;
  if (sub.window_anchor) return sub.window_anchor;
  if (sub.month_anchor) return `${sub.month_anchor}-01 00:00:00`;
  return null;
}

/**
 * Une recharge est-elle due maintenant ? Renvoie le début de la fenêtre à
 * ouvrir, ou null. Jamais pour un mensuel, un suspendu, un résilié, ni après
 * period_end ; une fenêtre déjà ouverte (window_anchor) ne l'est pas deux fois.
 */
export function rechargeDue(sub: WindowedSub, now: string): string | null {
  if (!sub.period_end || now >= sub.period_end) return null;
  if (sub.suspended || sub.status === "canceled") return null;
  if (!isYearly(sub)) return null;
  const anchor = anchorOf(sub);
  if (!anchor || anchor > now) return null;
  const win = currentWindowStart(anchor, now);
  if (sub.window_anchor && win <= sub.window_anchor) return null;
  if (!sub.window_anchor && win === anchor) return null; // première fenêtre : ouverte par la facture elle-même
  return win;
}

/** Date (YYYY-MM-DD) de la prochaine recharge affichable : prochaine fenêtre (annuel) ou prochaine facture (mensuel). */
export function nextRechargeDate(sub: WindowedSub, now: string): string | null {
  if (!sub.period_end || now >= sub.period_end || sub.suspended || sub.status === "canceled") return null;
  if (!isYearly(sub)) return sub.period_end.slice(0, 10);
  const anchor = anchorOf(sub);
  if (!anchor) return null;
  const next = nextWindowStart(anchor, now, sub.period_end);
  return (next ?? sub.period_end).slice(0, 10);
}
