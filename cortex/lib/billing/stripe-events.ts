import type Stripe from "stripe";
import { authGet, authRun } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { log } from "@/lib/metrics";
import {
  addTransaction, getSubscription, grantSubscriptionMonth, linkSubscription, resolveUserByCustomer,
  setSubscriptionStatus, subscriptionCreditsCenti, subscriptionMonthlyCreditsCenti, toCenti,
} from "./credits";

/**
 * TRAITEMENT DES ÉVÉNEMENTS STRIPE (webhook). Séparé de la route pour être
 * testable sans signature : la route vérifie la signature (corps brut) et la
 * cohérence livemode/clé, puis appelle `handleStripeEvent(event)`.
 *
 * OFFRES, référencées par LOOKUP_KEY (aucun id en dur → bascule test/live sans code) :
 *  - cortex_pro_monthly / cortex_pro_yearly → abonnement Pro (20 crédits/mois,
 *    non reportables, attribués par facture payée : l'annuel reçoit 20/mois par
 *    recharge paresseuse) ;
 *  - cortex_credits_10 → pack unique de 10 crédits, permanents.
 *
 * IDEMPOTENCE, trois remparts : `processed_events` (event.id) ; la référence
 * de l'objet métier (`stripe:cs:<session>` pour un pack, `stripe_invoices`
 * pour une facture, `stripe:reversal:<payment_intent>` pour une reprise) ;
 * les opérations elles-mêmes (upsert, ref UNIQUE). Un même achat sous deux
 * événements (completed puis async_payment_succeeded) ne crédite qu'une fois.
 *
 * REPRISES : charge.refunded et charge.dispute.created remontent au
 * payment_intent → achat (pack) ou facture (abonnement). Pack : tous les
 * crédits de l'achat sont retirés (solde négatif possible → tout est bloqué).
 * Facture : les crédits du mois encore présents sont retirés, et ce qui a déjà
 * été consommé passe en dette dans le ledger — le compte est bloqué jusqu'au
 * prochain achat. Une seule reprise par payment_intent (refund puis litige
 * sur le même achat ne reprennent pas deux fois). Unités : centièmes.
 */

export type PlanKey = "pro_monthly" | "pro_yearly" | "credits_10";
export type PlanSpec = { lookupKey: string; mode: "subscription" | "payment"; credits?: number; label: string };

export const PLANS: Record<PlanKey, PlanSpec> = {
  pro_monthly: { lookupKey: "cortex_pro_monthly", mode: "subscription", label: "Pro — mensuel" },
  pro_yearly: { lookupKey: "cortex_pro_yearly", mode: "subscription", label: "Pro — annuel" },
  credits_10: { lookupKey: "cortex_credits_10", mode: "payment", credits: 10, label: "Pack de 10 crédits" },
};

export function isPlanKey(v: unknown): v is PlanKey {
  return typeof v === "string" && v in PLANS;
}

/** id depuis un champ Stripe qui est soit une string, soit l'objet étendu. */
export function idOf(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && "id" in (v as Record<string, unknown>)) return String((v as { id: unknown }).id);
  return null;
}

/** Timestamp Stripe (secondes) → "YYYY-MM-DD HH:MM:SS" UTC (format nowStr). */
function unixToStr(unix: number | null | undefined): string | null {
  if (!unix || !Number.isFinite(unix)) return null;
  return new Date(unix * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function invoicePeriodEnd(inv: Stripe.Invoice): string | null {
  const line = inv.lines?.data?.[0] as { period?: { end?: number } } | undefined;
  return unixToStr(line?.period?.end) ?? unixToStr((inv as { period_end?: number }).period_end);
}

async function isProcessed(eventId: string): Promise<boolean> {
  return !!(await authGet<{ event_id: string }>(`SELECT event_id FROM processed_events WHERE event_id = ?`, eventId));
}
async function markProcessed(eventId: string): Promise<void> {
  try {
    await authRun(`INSERT INTO processed_events (event_id, created_at) VALUES (?, ?)`, eventId, nowStr());
  } catch (e) {
    if (!/unique|constraint/i.test(String(e))) throw e; // course : déjà marqué
  }
}

export type HandleResult = {
  ok: boolean; action: string; duplicate?: boolean; credited?: boolean; reversed?: boolean; error?: string;
};

/** Traite un événement Stripe DÉJÀ vérifié. Idempotent. Lève pour un échec RETRYABLE (la route répond 500). */
export async function handleStripeEvent(event: Stripe.Event): Promise<HandleResult> {
  if (await isProcessed(event.id)) return { ok: true, action: "duplicate", duplicate: true, credited: false, reversed: false };

  let res: HandleResult;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      res = await onCheckout(event.data.object as Stripe.Checkout.Session, event.id);
      break;
    case "invoice.paid":
      res = await onInvoicePaid(event.data.object as Stripe.Invoice);
      break;
    case "customer.subscription.updated":
      res = await onSubscriptionUpdated(event.data.object as Stripe.Subscription);
      break;
    case "customer.subscription.deleted":
      res = await onSubscriptionDeleted(event.data.object as Stripe.Subscription);
      break;
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      res = await reverseByPaymentIntent(idOf(charge.payment_intent), "remboursement Stripe");
      break;
    }
    case "charge.dispute.created": {
      const dispute = event.data.object as Stripe.Dispute;
      res = await reverseByPaymentIntent(idOf(dispute.payment_intent), "litige Stripe");
      break;
    }
    default:
      res = { ok: true, action: `ignored:${event.type}` };
  }
  // Marqué APRÈS succès : un échec transitoire laisse Stripe réessayer.
  if (res.ok) await markProcessed(event.id);
  return res;
}

async function onCheckout(s: Stripe.Checkout.Session, eventId: string): Promise<HandleResult> {
  const userId = s.metadata?.cortexUserId ?? null;
  const plan = s.metadata?.plan ?? null;

  if (s.mode === "subscription") {
    if (!userId) return { ok: false, action: "checkout-sub", error: "cortexUserId manquant" };
    // Pas de crédit ici : c'est invoice.paid qui attribue. On lie client → utilisateur.
    await linkSubscription({ userId, customerId: idOf(s.customer), subscriptionId: idOf(s.subscription), plan });
    return { ok: true, action: "subscription-linked" };
  }

  // Pack : crédité seulement si réellement payé (moyen différé → async_payment_succeeded).
  if (s.payment_status !== "paid" && s.payment_status !== "no_payment_required") {
    return { ok: true, action: "pack-unpaid", credited: false };
  }
  const credits = Number(s.metadata?.credits ?? 0);
  if (!userId || !(credits > 0)) return { ok: false, action: "pack", error: "métadonnées manquantes" };
  // Idempotence par SESSION (+ lignes créditées par l'ancien code sous l'id d'événement).
  const legacy = await authGet<{ id: number }>(`SELECT id FROM credit_transactions WHERE ref = ?`, eventId);
  if (legacy) return { ok: true, action: "pack-credited", credited: false };
  const ref = `stripe:cs:${s.id}`;
  const centi = toCenti(credits);
  const credited = await addTransaction(userId, centi, `achat ${plan ?? "pack"}`, ref);
  if (credited) {
    await authRun(
      `INSERT INTO stripe_purchases (session_id, payment_intent, user_id, credits_centi, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT (session_id) DO NOTHING`,
      s.id, idOf(s.payment_intent), userId, centi, nowStr(),
    ).catch((e) => log("warn", "stripe.purchase_record_failed", { message: String(e).slice(0, 200) }));
  }
  return { ok: true, action: "pack-credited", credited };
}

async function onInvoicePaid(inv: Stripe.Invoice): Promise<HandleResult> {
  const subId = idOf((inv as { subscription?: unknown }).subscription);
  if (!subId) return { ok: true, action: "invoice-non-subscription" };
  // Idempotence par FACTURE : une facture n'attribue qu'un mois, quel que soit l'événement qui la porte.
  if (inv.id && (await authGet<{ invoice_id: string }>(`SELECT invoice_id FROM stripe_invoices WHERE invoice_id = ?`, inv.id))) {
    return { ok: true, action: "invoice-duplicate", duplicate: true };
  }
  const customerId = idOf(inv.customer);
  let userId = customerId ? await resolveUserByCustomer(customerId) : null;
  if (!userId) {
    userId =
      (inv as { subscription_details?: { metadata?: Record<string, string> } }).subscription_details?.metadata?.cortexUserId ??
      (inv.metadata?.cortexUserId as string | undefined) ?? null;
  }
  // Introuvable → on LÈVE (500) pour que Stripe réessaie : le checkout qui lie
  // client → utilisateur peut arriver après la facture.
  if (!userId) throw new Error(`invoice.paid : utilisateur introuvable (customer ${customerId ?? "?"}) — retry`);
  const periodEnd = invoicePeriodEnd(inv);
  if (!periodEnd) throw new Error(`invoice.paid : période introuvable (sub ${subId}) — retry`);
  const plan = (inv.lines?.data?.[0] as { price?: { lookup_key?: string } } | undefined)?.price?.lookup_key ?? null;
  await grantSubscriptionMonth({ userId, customerId, subscriptionId: subId, plan, periodEnd });
  if (inv.id) {
    await authRun(
      `INSERT INTO stripe_invoices (invoice_id, subscription_id, customer_id, payment_intent, user_id, granted_centi, period_end, created_at)
       VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (invoice_id) DO NOTHING`,
      inv.id, subId, customerId, idOf((inv as { payment_intent?: unknown }).payment_intent), userId,
      subscriptionMonthlyCreditsCenti(), periodEnd, nowStr(),
    );
  }
  return { ok: true, action: "subscription-granted" };
}

async function onSubscriptionUpdated(sub: Stripe.Subscription): Promise<HandleResult> {
  // cancel_at_period_end : l'abonnement reste ACTIF jusqu'à la fin de période ; le vrai arrêt vient de .deleted.
  const periodEnd = unixToStr((sub as { current_period_end?: number }).current_period_end);
  await setSubscriptionStatus({ subscriptionId: sub.id, customerId: idOf(sub.customer), status: sub.status, periodEnd });
  return { ok: true, action: "subscription-updated" };
}

async function onSubscriptionDeleted(sub: Stripe.Subscription): Promise<HandleResult> {
  await setSubscriptionStatus({ subscriptionId: sub.id, customerId: idOf(sub.customer), status: "canceled", clearRemaining: true });
  log("info", "billing.subscription_deleted", { subscription: sub.id });
  return { ok: true, action: "subscription-deleted" };
}

/** Reprise des crédits d'un paiement remboursé/contesté — pack OU facture d'abonnement, une seule fois. */
async function reverseByPaymentIntent(paymentIntent: string | null, why: string): Promise<HandleResult> {
  if (!paymentIntent) return { ok: true, action: "reversal", reversed: false, error: "payment_intent absent" };
  const ref = `stripe:reversal:${paymentIntent}`;
  if (await authGet<{ id: number }>(`SELECT id FROM credit_transactions WHERE ref = ?`, ref)) {
    return { ok: true, action: "reversal-duplicate", reversed: false };
  }
  const purchase = await authGet<{ user_id: string; credits_centi: number }>(
    `SELECT user_id, credits_centi FROM stripe_purchases WHERE payment_intent = ?`, paymentIntent,
  );
  if (purchase) {
    const reversed = await addTransaction(purchase.user_id, -Number(purchase.credits_centi), why, ref);
    return { ok: true, action: "pack-reversed", reversed };
  }
  const invoice = await authGet<{ user_id: string; granted_centi: number }>(
    `SELECT user_id, granted_centi FROM stripe_invoices WHERE payment_intent = ?`, paymentIntent,
  );
  if (invoice) {
    // Ce qui reste du mois est retiré de l'abonnement ; ce qui a déjà été
    // consommé devient une dette dans le ledger (solde négatif → tout est bloqué).
    const remaining = await subscriptionCreditsCenti(invoice.user_id);
    const granted = Number(invoice.granted_centi);
    const take = Math.min(remaining, granted);
    if (take > 0 && (await getSubscription(invoice.user_id))) {
      await authRun(`UPDATE subscriptions SET remaining = remaining - ?, updated_at = ? WHERE user_id = ?`, take, nowStr(), invoice.user_id);
    }
    const reversed = await addTransaction(invoice.user_id, -(granted - take), `${why} (abonnement)`, ref);
    return { ok: true, action: "invoice-reversed", reversed };
  }
  log("warn", "stripe.reversal_unknown_payment", { paymentIntent, why });
  return { ok: true, action: "reversal", reversed: false, error: "paiement inconnu" };
}
