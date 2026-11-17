import { standingOf } from "@/lib/billing/subscription-windows";

/**
 * OÙ VIVENT LES ORIGINAUX D'UN COMPTE — décision de Ben du 17/11/2026, verrouillée.
 *
 * Un compte GRATUIT ne stocke rien dans le cloud aux frais de Cortex : ses fichiers restent
 * sur son ordinateur. Un envoi transite par le serveur le temps d'en extraire le texte, puis
 * l'original est supprimé ; seul l'index reste (texte, découpage : recherche et génération).
 * Le cloud (accès depuis n'importe où, aperçu servi par le serveur) est réservé au PREMIUM :
 *  1. le propriétaire de l'instance (lib/billing/owner) ;
 *  2. un compte qui a payé dans les 365 derniers jours, paiement resté net positif (ni
 *     remboursé ni contesté en entier : lib/billing/revenue, PR #88) — même fenêtre que la
 *     croissance du quota de stockage ;
 *  3. un abonnement en règle (`live` ou `renewing`), filet quand la ligne de paiement n'est pas
 *     encore écrite.
 * Fin du Premium (`cloudUntil`) : 365 jours après le dernier paiement, ou la fin de la période
 * payée de l'abonnement si elle vient après. La rétention (lib/originals/retention) garde les
 * originaux 30 jours de plus, puis les supprime ; l'index reste.
 *
 * La règle ne vaut qu'avec la facturation (BILLING_ENABLED=1) : sans elle aucun compte n'est
 * gratuit, tout reste comme avant (dev, instance perso). FREE_ORIGINALS_CLOUD=1 la coupe.
 * Base illisible : « cloud », raison `unknown` — on ne perd jamais l'original d'un abonné sur une
 * panne, et la rétention ne supprime rien sur cette raison-là.
 */

export type OriginalsHome = "cloud" | "local";
export type OriginalsReason = "rule_off" | "owner" | "paid" | "subscription" | "free" | "unknown";
export type OriginalsPolicy = {
  home: OriginalsHome;
  reason: OriginalsReason;
  /** Fin du droit au cloud ("YYYY-MM-DD HH:MM:SS" UTC) ; null : sans échéance (propriétaire, règle coupée) ou jamais payé. */
  cloudUntil: string | null;
};

const DAY_MS = 86400_000;
export const PAID_CLOUD_DAYS = 365;

const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const parse = (s: string) => Date.parse(`${s.slice(0, 19).replace(" ", "T")}Z`);

export function originalsRuleActive(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return env.BILLING_ENABLED === "1" && env.FREE_ORIGINALS_CLOUD !== "1";
}

export async function originalsPolicy(userId: string, now: string = stamp(Date.now())): Promise<OriginalsPolicy> {
  if (!originalsRuleActive()) return { home: "cloud", reason: "rule_off", cloudUntil: null };
  try {
    const { isOwner } = await import("@/lib/billing/owner");
    if (await isOwner(userId)) return { home: "cloud", reason: "owner", cloudUntil: null };
    const { lastNetPaymentAt } = await import("@/lib/billing/revenue");
    const { getSubscription } = await import("@/lib/billing/credits");
    const [paidAt, sub] = await Promise.all([lastNetPaymentAt(userId, now), getSubscription(userId)]);
    const paidUntil = paidAt ? stamp(parse(paidAt) + PAID_CLOUD_DAYS * DAY_MS) : null;
    const standing = standingOf(sub, now);
    const periodEnd = sub?.period_end ?? null;
    const cloudUntil = [paidUntil, periodEnd].filter((d): d is string => !!d).sort().at(-1) ?? null;
    if (paidUntil && now < paidUntil) return { home: "cloud", reason: "paid", cloudUntil };
    if (standing === "live" || standing === "renewing") return { home: "cloud", reason: "subscription", cloudUntil };
    return { home: "local", reason: "free", cloudUntil };
  } catch {
    return { home: "cloud", reason: "unknown", cloudUntil: null };
  }
}
