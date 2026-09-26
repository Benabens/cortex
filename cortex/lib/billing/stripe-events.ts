import type Stripe from "stripe";
import { authGet, authRun, authTx } from "@/db/auth-store";
import { dbDriverName, nowStr } from "@/db/q";
import { log } from "@/lib/metrics";
import {
  DELTA_CENTI, addTransaction, ensureLedgerUnit, getSubscription, grantSubscriptionMonth, linkSubscription, resolveUserByCustomer,
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
 *
 * PAIEMENT INCONNU EN BASE (achat antérieur à `stripe_purchases`, ou événements
 * dans le désordre) : on remonte, dans l'ordre, à la session Checkout via l'API
 * Stripe (`lookup`), aux métadonnées de la charge (payment_intent_data), au
 * client/e-mail + montant converti en crédits au prix du pack. Sinon la reprise
 * est MÉMORISÉE (`stripe_orphan_reversals`), signalée en erreur, et appliquée
 * dès que l'achat correspondant arrive. Jamais silencieux.
 *
 * ATOMICITÉ : crédit du pack et enregistrement de l'achat vont dans la même
 * transaction — un échec lève (500 → rejeu Stripe), rien n'est crédité à moitié.
 */

/** Prix d'un crédit en centimes pour convertir un montant remboursé (pack : 9 € les 10). CREDIT_PRICE_CENTS pour l'ajuster. */
export function creditPriceCents(): number {
  const n = Number(process.env.CREDIT_PRICE_CENTS);
  return Number.isFinite(n) && n > 0 ? n : 90;
}
/** Montant (centimes) → centièmes de crédit, arrondi. */
export function creditsCentiForAmount(amountCents: number): number {
  return Math.round((amountCents / creditPriceCents()) * 100);
}

/** Accès Stripe injecté par la route (testable sans réseau). */
export type StripeLookup = {
  sessionByPaymentIntent(paymentIntent: string): Promise<{ id: string; userId: string | null; credits: number | null } | null>;
};
export type HandleOptions = { lookup?: StripeLookup };

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
export async function handleStripeEvent(event: Stripe.Event, opts: HandleOptions = {}): Promise<HandleResult> {
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
      res = await reverseByPaymentIntent(idOf(charge.payment_intent), "remboursement Stripe", {
        amountCents: Number(charge.amount_refunded ?? charge.amount ?? 0) || null,
        totalCents: Number(charge.amount ?? 0) || null,
        metadata: charge.metadata ?? null, customerId: idOf(charge.customer),
        email: charge.billing_details?.email ?? charge.receipt_email ?? null, lookup: opts.lookup,
      });
      break;
    }
    case "charge.dispute.created": {
      const dispute = event.data.object as Stripe.Dispute;
      const charge = typeof dispute.charge === "object" && dispute.charge ? (dispute.charge as Stripe.Charge) : null;
      res = await reverseByPaymentIntent(idOf(dispute.payment_intent), "litige Stripe", {
        amountCents: Number(dispute.amount ?? 0) || null,
        metadata: charge?.metadata ?? null, customerId: idOf(charge?.customer),
        email: charge?.billing_details?.email ?? null, lookup: opts.lookup,
      });
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

  // Pack : crédité seulement si de l'argent a RÉELLEMENT été encaissé — moyen
  // différé → async_payment_succeeded ; session gratuite (no_payment_required,
  // coupon 100 %, montant 0) → jamais de crédit.
  const amount = s.amount_total == null ? null : Number(s.amount_total);
  if (s.payment_status !== "paid" || (amount !== null && !(amount > 0))) {
    if (s.payment_status === "no_payment_required" || amount === 0) {
      log("warn", "stripe.free_session_ignored", { session: s.id, status: s.payment_status, amount });
    }
    return { ok: true, action: "pack-unpaid", credited: false };
  }
  const credits = Number(s.metadata?.credits ?? 0);
  if (!userId || !(credits > 0)) return { ok: false, action: "pack", error: "métadonnées manquantes" };
  // Idempotence par SESSION (+ lignes créditées par l'ancien code sous l'id d'événement).
  const legacy = await authGet<{ id: number }>(`SELECT id FROM credit_transactions WHERE ref = ?`, eventId);
  if (legacy) return { ok: true, action: "pack-credited", credited: false };
  const ref = `stripe:cs:${s.id}`;
  const centi = toCenti(credits);
  const pi = idOf(s.payment_intent);
  await ensureLedgerUnit();
  // Crédit + enregistrement de l'achat dans UNE transaction : un échec lève
  // (rien de crédité, 500 → Stripe rejoue) ; le ref UNIQUE tranche une course.
  const credited = await authTx(async (tx) => {
    if (await tx.get<{ id: number }>(`SELECT id FROM credit_transactions WHERE ref = ?`, ref)) return false;
    await tx.run(
      `INSERT INTO credit_transactions (user_id, delta, reason, ref, unit, created_at) VALUES (?,?,?,?,'centi',?)`,
      userId, centi, `achat ${plan ?? "pack"}`, ref, nowStr(),
    );
    await tx.run(
      `INSERT INTO stripe_purchases (session_id, payment_intent, user_id, credits_centi, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT (session_id) DO NOTHING`,
      s.id, pi, userId, centi, nowStr(),
    );
    return true;
  }).catch(async (e) => {
    // Course sur le ref UNIQUE : l'autre instance a crédité — vérifié, pas supposé.
    if (/unique|constraint/i.test(String(e)) && (await authGet<{ id: number }>(`SELECT id FROM credit_transactions WHERE ref = ?`, ref))) return false;
    throw e;
  });
  // Un remboursement/litige arrivé AVANT l'achat attendait ce moment.
  if (credited && pi) {
    const orphan = await authGet<{ why: string; amount_cents: number | null }>(`SELECT why, amount_cents FROM stripe_orphan_reversals WHERE payment_intent = ?`, pi);
    if (orphan) {
      // Remboursement partiel mémorisé : au prorata du montant, jamais plus que l'achat.
      const amount = Number(orphan.amount_cents ?? 0);
      const take = amount > 0 ? Math.min(centi, creditsCentiForAmount(amount)) : centi;
      const reversed = await addTransaction(userId, -take, `${orphan.why} (reçu avant l'achat)`, `stripe:reversal:${pi}`);
      await authRun(`DELETE FROM stripe_orphan_reversals WHERE payment_intent = ?`, pi);
      log("info", "stripe.orphan_reversal_applied", { paymentIntent: pi, user: userId });
      return { ok: true, action: "pack-credited-then-reversed", credited, reversed };
    }
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

type ReversalContext = {
  /** montant repris (remboursé cumulé, ou montant du litige), en centimes */
  amountCents?: number | null;
  /** montant total de la charge, en centimes (remboursement partiel → prorata) */
  totalCents?: number | null;
  metadata?: Record<string, string> | null;
  customerId?: string | null;
  email?: string | null;
  lookup?: StripeLookup;
};

async function userByEmail(email: string | null | undefined): Promise<string | null> {
  if (!email) return null;
  const r = await authGet<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower(?)`, email.trim());
  return r?.id ?? null;
}

/** Reprise des crédits d'un paiement remboursé/contesté — pack OU facture d'abonnement, une seule fois. */
async function reverseByPaymentIntent(paymentIntent: string | null, why: string, ctx: ReversalContext = {}): Promise<HandleResult> {
  if (!paymentIntent) return { ok: true, action: "reversal", reversed: false, error: "payment_intent absent" };
  const ref = `stripe:reversal:${paymentIntent}`;
  const purchase = await authGet<{ user_id: string; credits_centi: number }>(
    `SELECT user_id, credits_centi FROM stripe_purchases WHERE payment_intent = ?`, paymentIntent,
  );
  if (purchase) {
    // Remboursement PARTIEL → prorata du montant, arrondi au crédit SUPÉRIEUR,
    // cumulatif (Stripe renvoie amount_refunded cumulé à chaque remboursement) :
    // on reprend la différence avec ce qui l'a déjà été pour ce paiement.
    // Lecture du déjà-repris + écriture dans UNE transaction, sous verrou du
    // paiement (Postgres) / BEGIN IMMEDIATE (sqlite) : remboursement et litige
    // simultanés ne reprennent qu'une fois ; le ref UNIQUE tranche le reste.
    const full = Number(purchase.credits_centi);
    let target = full;
    if (ctx.amountCents && ctx.totalCents && ctx.amountCents < ctx.totalCents) {
      target = Math.min(full, Math.ceil((full / 100) * (ctx.amountCents / ctx.totalCents)) * 100);
    }
    await ensureLedgerUnit();
    const reversed = await authTx(async (tx) => {
      if (dbDriverName() === "postgres") await tx.run(`SELECT pg_advisory_xact_lock(hashtext(?))`, `reversal:${paymentIntent}`);
      const done = await tx.get<{ total: number | string | null }>(
        `SELECT coalesce(sum(-(${DELTA_CENTI})), 0) total FROM credit_transactions WHERE user_id = ? AND ref LIKE ?`,
        purchase.user_id, `${ref}%`,
      );
      const already = Number(done?.total ?? 0);
      const take = target - already;
      if (take <= 0) return false;
      const stepRef = already === 0 && take === full ? ref : `${ref}:${target}`;
      await tx.run(
        `INSERT INTO credit_transactions (user_id, delta, reason, ref, unit, created_at) VALUES (?,?,?,?,'centi',?)`,
        purchase.user_id, -take, target < full ? `${why} (partiel : ${ctx.amountCents}/${ctx.totalCents} centimes)` : why, stepRef, nowStr(),
      );
      return true;
    }).catch((e) => {
      if (/unique|constraint/i.test(String(e))) return false; // course perdue sur le ref : l'autre a repris
      throw e;
    });
    return { ok: true, action: reversed ? "pack-reversed" : "reversal-duplicate", reversed };
  }
  if (await authGet<{ id: number }>(`SELECT id FROM credit_transactions WHERE ref = ?`, ref)) {
    return { ok: true, action: "reversal-duplicate", reversed: false };
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
  // 3) Achat antérieur à `stripe_purchases` : Stripe sait quelle session porte ce paiement.
  if (ctx.lookup) {
    let session: Awaited<ReturnType<StripeLookup["sessionByPaymentIntent"]>> = null;
    try { session = await ctx.lookup.sessionByPaymentIntent(paymentIntent); }
    catch (e) { throw new Error(`Stripe injoignable pour retrouver la session de ${paymentIntent} — retry (${String(e).slice(0, 120)})`); }
    if (session?.userId && session.credits) {
      const centi = toCenti(session.credits);
      await authRun(
        `INSERT INTO stripe_purchases (session_id, payment_intent, user_id, credits_centi, created_at) VALUES (?,?,?,?,?) ON CONFLICT (session_id) DO NOTHING`,
        session.id, paymentIntent, session.userId, centi, nowStr(),
      );
      const reversed = await addTransaction(session.userId, -centi, `${why} (achat retrouvé via Stripe)`, ref);
      return { ok: true, action: "pack-reversed", reversed };
    }
  }
  // 4) Métadonnées portées par la charge (payment_intent_data) ; 5) client / e-mail connu. Montant → crédits au prix du pack.
  const metaUser = ctx.metadata?.cortexUserId ?? null;
  const metaCredits = Number(ctx.metadata?.credits ?? 0);
  const userId = metaUser
    ?? (ctx.customerId ? await resolveUserByCustomer(ctx.customerId) : null)
    ?? (await userByEmail(ctx.email));
  if (userId && ctx.amountCents && ctx.amountCents > 0) {
    // Remboursement partiel : au prorata du montant ; sinon, crédits des métadonnées si le montant couvre tout.
    const centi = creditsCentiForAmount(ctx.amountCents);
    const capped = metaCredits > 0 ? Math.min(centi, toCenti(metaCredits)) : centi;
    const reversed = await addTransaction(userId, -capped, `${why} (${ctx.amountCents} centimes → crédits)`, ref);
    log("warn", "stripe.reversal_by_amount", { paymentIntent, user: userId, amountCents: ctx.amountCents, centi: capped });
    return { ok: true, action: "pack-reversed-by-amount", reversed };
  }
  // 6) Rien d'exploitable : on MÉMORISE (appliqué si l'achat arrive ensuite) et on le dit fort.
  await authRun(
    `INSERT INTO stripe_orphan_reversals (payment_intent, why, amount_cents, created_at) VALUES (?,?,?,?) ON CONFLICT (payment_intent) DO NOTHING`,
    paymentIntent, why, ctx.amountCents ?? null, nowStr(),
  );
  log("error", "stripe.reversal_unresolved", { paymentIntent, why, amountCents: ctx.amountCents ?? null, customer: ctx.customerId ?? null });
  return { ok: true, action: "reversal-orphaned", reversed: false, error: `paiement inconnu (${paymentIntent}) : reprise mémorisée, à contrôler dans Stripe` };
}
