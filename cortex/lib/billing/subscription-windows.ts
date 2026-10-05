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
 *
 * PÉRIODE PAYÉE : `period_start` / `period_end` sont la période de la dernière
 * facture PAYÉE (invoice.paid), jamais celle que Stripe annonce au
 * renouvellement. EN RÈGLE : seul un abonnement `active` ou `trialing` donne
 * des crédits ; en retard de paiement, impayé, en pause ou résilié, il n'en
 * donne aucun, même dans une période payée.
 */
export type WindowedSub = {
  plan: string | null;
  period_start: string | null;
  period_end: string | null;
  month_anchor: string | null;
  window_anchor: string | null;
  status: string;
  suspended?: number | boolean | null;
  status_at?: string | null;
  updated_at?: string | null;
  cancel_at_period_end?: number | boolean | null;
};

const DAY_MS = 86_400_000;

/** Statuts Stripe d'un abonnement EN RÈGLE : les seuls sous lesquels il donne des crédits. */
const GOOD_STANDING = new Set(["active", "trialing"]);
export function inGoodStanding(status: string | null | undefined): boolean {
  return GOOD_STANDING.has(status ?? "");
}
/** Statuts Stripe d'un abonnement TERMINÉ : plus rien ne sera facturé. */
const ENDED = new Set(["canceled", "incomplete_expired"]);
/** Stripe tient-il encore cet abonnement pour vivant ? (en règle OU en attente de paiement : il facture ou relance.) */
export function stillBilling(status: string | null | undefined): boolean {
  return !!status && !ENDED.has(status);
}

/**
 * État d'un abonnement vu de l'app — la lecture UNIQUE dont dépendent les
 * crédits (live seul en donne), l'écran et la garde d'achat :
 *  - live      : période payée en cours, en règle ;
 *  - renewing  : en règle, mais la période payée est échue (ou pas encore
 *                ouverte) : Stripe encaisse — une heure environ au renouvellement ;
 *  - unpaid    : Stripe n'a pas pu encaisser (past_due, unpaid, incomplete, paused) ;
 *  - suspended : facture remboursée ou contestée, jusqu'à la prochaine facture payée ;
 *  - none      : pas d'abonnement, ou terminé.
 */
export type Standing = "none" | "live" | "renewing" | "unpaid" | "suspended";

/** Sans facture payée dans ce délai après l'échéance, un abonnement encore « en règle » est tenu pour terminé (événement de fin perdu). */
const RENEWAL_GRACE_MS = 3 * DAY_MS;

export function standingOf(
  sub: Pick<WindowedSub, "status" | "period_end" | "suspended" | "status_at" | "updated_at"> | null | undefined,
  now: string,
): Standing {
  if (!sub || ENDED.has(sub.status)) return "none";
  if (!inGoodStanding(sub.status)) return "unpaid";
  if (sub.period_end && now < sub.period_end) return sub.suspended ? "suspended" : "live";
  const since = sub.period_end ?? sub.status_at ?? sub.updated_at ?? null;
  return since && parse(now).getTime() - parse(since).getTime() < RENEWAL_GRACE_MS ? "renewing" : "none";
}

/**
 * Refus d'un SECOND abonnement, ou null. Tant que Stripe tient le premier pour
 * vivant il continue de facturer : en ouvrir un autre ferait payer deux fois
 * (et la ligne `subscriptions`, une par compte, ne suivrait que le dernier).
 */
export function secondSubscriptionRefusal(standing: Standing): string | null {
  switch (standing) {
    case "none": return null;
    case "live": return "Tu as déjà un abonnement en cours. Gère-le depuis Mon compte (moyen de paiement, résiliation) plutôt que d'en ouvrir un second.";
    case "renewing": return "Ton abonnement est en cours de renouvellement : tes crédits arrivent dès que le paiement est confirmé, en général sous une heure. Inutile d'en ouvrir un second.";
    case "unpaid": return "Le dernier paiement de ton abonnement n'est pas passé. Mets à jour ton moyen de paiement depuis « Gérer mon abonnement » plutôt que d'en ouvrir un second.";
    case "suspended": return "Ton abonnement est suspendu après un remboursement ou une contestation de paiement. Gère-le depuis « Gérer mon abonnement » plutôt que d'en ouvrir un second.";
  }
}

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
 * ouvrir, ou null. Jamais pour un mensuel, un suspendu, un abonnement qui
 * n'est pas en règle, ni après period_end ; une fenêtre déjà ouverte
 * (window_anchor) ne l'est pas deux fois.
 */
export function rechargeDue(sub: WindowedSub, now: string): string | null {
  if (!sub.period_end || now >= sub.period_end) return null;
  if (sub.suspended || !inGoodStanding(sub.status)) return null;
  if (!isYearly(sub)) return null;
  const anchor = anchorOf(sub);
  if (!anchor || anchor > now) return null;
  const win = currentWindowStart(anchor, now);
  if (sub.window_anchor && win <= sub.window_anchor) return null;
  if (!sub.window_anchor && win === anchor) return null; // première fenêtre : ouverte par la facture elle-même
  return win;
}

/**
 * Date (YYYY-MM-DD) de la prochaine recharge affichable : prochaine fenêtre
 * (annuel) ou prochaine facture (mensuel). Résiliation programmée : il n'y aura
 * pas de prochaine facture, seules les fenêtres de la période payée restent.
 */
export function nextRechargeDate(sub: WindowedSub, now: string): string | null {
  if (!sub.period_end || now >= sub.period_end || sub.suspended || !inGoodStanding(sub.status)) return null;
  const nextInvoice = sub.cancel_at_period_end ? null : sub.period_end;
  if (!isYearly(sub)) return nextInvoice?.slice(0, 10) ?? null;
  const anchor = anchorOf(sub);
  if (!anchor) return null;
  const next = nextWindowStart(anchor, now, sub.period_end);
  return (next ?? nextInvoice)?.slice(0, 10) ?? null;
}
