import { PLANS, type PlanKey } from "./stripe-events";
import { fromCenti, subscriptionMonthlyCreditsCenti } from "./credits";

/**
 * OFFRES affichées par la page « Abonnement & crédits ». Le montant réel vit
 * dans Stripe (prix résolus par lookup_key) : on le lit à la demande, avec un
 * cache court, pour ne jamais afficher un prix qui dérive de celui facturé.
 * Sans clé Stripe (dev, facturation coupée), le prix est null et l'interface
 * le dit au lieu d'inventer un montant.
 */
export type Offer = {
  plan: PlanKey;
  kind: "subscription" | "pack";
  label: string;
  /** Crédits du pack, ou crédits par mois de l'abonnement. */
  credits: number;
  interval: "month" | "year" | null;
  price: { amount: number; currency: string } | null;
};

type PriceInfo = { amount: number; currency: string; interval: "month" | "year" | null };
let _cache: { at: number; prices: Record<string, PriceInfo> } | null = null;
const CACHE_MS = 10 * 60_000;

/** Prix Stripe par lookup_key (cache 10 min). Jamais bloquant : erreur → {}. */
export async function stripePrices(): Promise<Record<string, PriceInfo>> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return {};
  if (_cache && Date.now() - _cache.at < CACHE_MS) return _cache.prices;
  try {
    const { default: Stripe } = await import("stripe");
    const stripe = new Stripe(key);
    const keys = Object.values(PLANS).map((p) => p.lookupKey);
    const list = await stripe.prices.list({ lookup_keys: keys, active: true, limit: 10 });
    const prices: Record<string, PriceInfo> = {};
    for (const p of list.data) {
      if (!p.lookup_key || typeof p.unit_amount !== "number") continue;
      const interval = p.recurring?.interval === "year" ? "year" : p.recurring?.interval === "month" ? "month" : null;
      prices[p.lookup_key] = { amount: p.unit_amount / 100, currency: p.currency.toUpperCase(), interval };
    }
    _cache = { at: Date.now(), prices };
    return prices;
  } catch {
    return _cache?.prices ?? {};
  }
}

export async function listOffers(): Promise<Offer[]> {
  const prices = await stripePrices();
  const perMonth = fromCenti(subscriptionMonthlyCreditsCenti());
  return (Object.keys(PLANS) as PlanKey[]).map((plan) => {
    const spec = PLANS[plan];
    const p = prices[spec.lookupKey];
    return {
      plan,
      kind: spec.mode === "subscription" ? "subscription" : "pack",
      label: spec.label,
      credits: spec.credits ?? perMonth,
      interval: spec.mode === "subscription" ? (plan === "pro_yearly" ? "year" : "month") : null,
      price: p ? { amount: p.amount, currency: p.currency } : null,
    };
  });
}
