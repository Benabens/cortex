import type Stripe from "stripe";
import { authGet, authRun, authTx } from "@/db/auth-store";
import { dbDriverName, nowStr } from "@/db/q";
import { log } from "@/lib/metrics";
import { checkoutParams } from "./checkout-params";
import { PLANS, type PlanKey } from "./stripe-events";
import { refusal, type Refusal } from "@/lib/i18n/user-error";

/**
 * OUVERTURE D'UN CHECKOUT STRIPE — un seul abonnement par compte, même avant le webhook.
 *
 * La garde de la route (secondSubscriptionRefusal) lit l'abonnement EN BASE, que seul le
 * webhook écrit : deux onglets ouverts puis payés donnaient deux abonnements chez Stripe,
 * l'app n'en voyait qu'un et l'autre facturait quand même (audit du 14/11/2026, n° 7). Ici :
 *  1. un VERROU par compte (checkout_locks) : un seul Checkout d'abonnement ouvert. Le
 *     précédent est expiré chez Stripe avant d'en ouvrir un autre ; deux requêtes
 *     simultanées → la seconde est refusée (409) ;
 *  2. un CLIENT Stripe unique par compte (stripe_customers, ou celui d'un ancien abonnement),
 *     passé à chaque session : ses abonnements se lisent chez Stripe ;
 *  3. avant d'ouvrir un abonnement, l'état RÉEL des abonnements de ce client chez Stripe :
 *     un onglet déjà payé dont le webhook n'est pas arrivé bloque le second.
 * La session d'abonnement expire au bout de 30 min (minimum Stripe) : le verrou ne bloque pas
 * plus longtemps qu'elle n'est payable. Un pack (achat ponctuel) n'est pas verrouillé : en
 * acheter deux est légitime.
 */

/** Ce que ce module appelle chez Stripe (le client réel convient ; un faux en mémoire pour les tests). */
export type CheckoutStripe = {
  customers: { create(p: Stripe.CustomerCreateParams, o?: Stripe.RequestOptions): Promise<{ id: string }> };
  subscriptions: { list(p: Stripe.SubscriptionListParams): Promise<{ data: Array<{ status: string }> }> };
  checkout: {
    sessions: {
      create(p: Stripe.Checkout.SessionCreateParams): Promise<{ id: string; url: string | null }>;
      retrieve(id: string): Promise<{ status: string | null; customer?: string | { id: string } | null }>;
      expire(id: string): Promise<unknown>;
    };
  };
};

export type CheckoutOutcome =
  | { ok: true; url: string; sessionId: string }
  | ({ ok: false } & Refusal<409>);

/** Statuts d'un abonnement Stripe qui facture encore, ou va facturer. */
const BILLING_STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);
/** Durée de vie d'une session d'abonnement : 30 min, le minimum accepté par Stripe (+ 1 min de marge réseau). */
const SESSION_TTL_S = 31 * 60;
/** Un verrou « en cours d'ouverture » plus vieux que ça vient d'une requête morte : il ne bloque plus. */
const OPENING_STALE_MS = 2 * 60_000;

/** Prend le verrou de checkout du compte. Rend la session précédente à expirer, ou un refus. */
async function claimLock(userId: string): Promise<{ ok: true; previous: string | null } | { ok: false }> {
  return authTx(async (tx) => {
    if (dbDriverName() === "postgres") await tx.run(`SELECT pg_advisory_xact_lock(hashtext(?))`, `checkout:${userId}`);
    const row = await tx.get<{ session_id: string | null; created_at: string }>(`SELECT session_id, created_at FROM checkout_locks WHERE user_id = ?`, userId);
    if (row && !row.session_id && Date.now() - new Date(row.created_at + "Z").getTime() < OPENING_STALE_MS) return { ok: false as const };
    await tx.run(`DELETE FROM checkout_locks WHERE user_id = ?`, userId);
    await tx.run(`INSERT INTO checkout_locks (user_id, session_id, created_at) VALUES (?, NULL, ?)`, userId, nowStr());
    return { ok: true as const, previous: row?.session_id ?? null };
  });
}

async function releaseLock(userId: string): Promise<void> {
  await authRun(`DELETE FROM checkout_locks WHERE user_id = ?`, userId).catch(() => {});
}

/** Clé restreinte sans le droit « Customers » (docs/STRIPE-LIVE.md § 6) : Stripe répond 403. */
function permissionDenied(e: unknown): boolean {
  const x = e as { type?: string; statusCode?: number } | null;
  return x?.type === "StripePermissionError" || x?.statusCode === 403;
}

/**
 * Le client Stripe du compte : celui d'un ancien abonnement, sinon celui créé par Cortex (créé au
 * besoin). null si la clé n'a pas le droit de créer un client : la session retombe sur l'ancien
 * comportement (client créé par Checkout), le verrou garde, mais l'état chez Stripe n'est pas lu.
 */
async function customerFor(stripe: CheckoutStripe, userId: string, email: string | null): Promise<string | null> {
  const known = (await authGet<{ customer_id: string | null }>(`SELECT customer_id FROM subscriptions WHERE user_id = ? AND customer_id IS NOT NULL`, userId))?.customer_id
    ?? (await authGet<{ customer_id: string }>(`SELECT customer_id FROM stripe_customers WHERE user_id = ?`, userId))?.customer_id;
  if (known) return known;
  // Clé d'idempotence : deux achats simultanés reçoivent le même client (24 h chez Stripe).
  let c: { id: string };
  try {
    c = await stripe.customers.create(
      { ...(email ? { email } : {}), metadata: { app: "cortex", cortexUserId: userId } },
      { idempotencyKey: `cortex-customer-${userId}` },
    );
  } catch (e) {
    if (!permissionDenied(e)) throw e;
    log("warn", "stripe.customer_permission_missing", { hint: "droit Customers (écriture) absent de la clé restreinte" });
    return null;
  }
  await authRun(`INSERT INTO stripe_customers (user_id, customer_id, created_at) VALUES (?,?,?) ON CONFLICT (user_id) DO NOTHING`, userId, c.id, nowStr());
  return (await authGet<{ customer_id: string }>(`SELECT customer_id FROM stripe_customers WHERE user_id = ?`, userId))?.customer_id ?? c.id;
}

export async function openCheckout(o: { stripe: CheckoutStripe; userId: string; plan: PlanKey; priceId: string; email: string | null }): Promise<CheckoutOutcome> {
  const subscription = PLANS[o.plan].mode === "subscription";
  if (!subscription) {
    const customer = await customerFor(o.stripe, o.userId, o.email);
    const s = await o.stripe.checkout.sessions.create(checkoutParams({ plan: o.plan, priceId: o.priceId, userId: o.userId, email: o.email, customer: customer ?? undefined }));
    return { ok: true, url: s.url ?? "", sessionId: s.id };
  }

  const lock = await claimLock(o.userId);
  if (!lock.ok) return { ok: false, ...refusal(409, "checkout_subscription_opening") };
  let created: string | null = null;
  try {
    // L'onglet précédent ne doit plus pouvoir payer. Déjà payé ou expiré : expire échoue, c'est
    // l'état des abonnements chez Stripe (ci-dessous) qui tranche.
    let paidCustomer: string | null = null;
    if (lock.previous) {
      const prev = await o.stripe.checkout.sessions.retrieve(lock.previous).catch(() => null);
      if (prev?.status === "open") await o.stripe.checkout.sessions.expire(lock.previous).catch(() => {});
      if (prev?.status === "complete" && prev.customer) paidCustomer = typeof prev.customer === "string" ? prev.customer : prev.customer.id;
    }
    // Sans le droit Customers (pas de client à nous), le client que Checkout a créé pour l'onglet
    // payé suffit à relire ses abonnements.
    const customer = (await customerFor(o.stripe, o.userId, o.email)) ?? paidCustomer;
    const existing = customer ? (await o.stripe.subscriptions.list({ customer, status: "all", limit: 20 })).data : [];
    if (existing.some((s) => BILLING_STATUSES.has(s.status))) {
      await releaseLock(o.userId);
      return { ok: false, ...refusal(409, "checkout_subscription_exists") };
    }
    const s = await o.stripe.checkout.sessions.create(checkoutParams({
      plan: o.plan, priceId: o.priceId, userId: o.userId, email: o.email, customer: customer ?? undefined, expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
    }));
    created = s.id;
    await authRun(`UPDATE checkout_locks SET session_id = ?, created_at = ? WHERE user_id = ?`, s.id, nowStr(), o.userId);
    return { ok: true, url: s.url ?? "", sessionId: s.id };
  } catch (e) {
    // Une session créée mais pas inscrite au verrou ne doit pas rester payable : elle échapperait
    // à l'expiration par l'onglet suivant.
    if (created) await o.stripe.checkout.sessions.expire(created).catch(() => {});
    await releaseLock(o.userId).catch(() => {});
    throw e;
  }
}
