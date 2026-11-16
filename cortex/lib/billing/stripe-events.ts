import type Stripe from "stripe";
import { authGet, authRun, authTx } from "@/db/auth-store";
import { dbDriverName, nowStr } from "@/db/q";
import { log } from "@/lib/metrics";
import {
  DELTA_CENTI, addTransaction, ensureLedgerUnit, getSubscription, grantSubscriptionMonth, linkSubscription, resolveUserByCustomer, withdrawSubscriptionInTx,
  setSubscriptionStatus, subscriptionCreditsCenti, subscriptionLive, subscriptionMonthlyCreditsCenti, toCenti,
} from "./credits";
import { linkInvoicePaymentIntent, recordDispute, recordPayment, recordRefund } from "./revenue";

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
 * payment_intent → achat (pack) ou facture (abonnement), au prorata de la part
 * remboursée (cumul amount_refunded / montant ; un litige reprend tout). Pack :
 * la part des crédits de l'achat est retirée (solde négatif possible → tout est
 * bloqué). Facture : la part n'est prise que sur la période de CETTE facture
 * (`reverseInvoice`) ; seul un remboursement total de la facture en cours
 * suspend. Cumulatif et idempotent par payment_intent (refund puis litige sur
 * le même achat ne reprennent pas deux fois). Chaque décision est journalisée
 * (`stripe.reversal_decision`). Unités : centièmes.
 *
 * PAIEMENT INCONNU EN BASE (achat antérieur à `stripe_purchases`, ou événements
 * dans le désordre) : on remonte, dans l'ordre, à la session Checkout via l'API
 * Stripe (`lookup`), puis, SEULEMENT si la charge porte la marque Cortex, à ses
 * métadonnées (payment_intent_data) ou au client déjà lié + montant converti en
 * crédits au prix du pack. Jamais à l'e-mail. Sinon la reprise
 * est MÉMORISÉE (`stripe_orphan_reversals`), signalée en erreur, et appliquée
 * dès que l'achat correspondant arrive. Jamais silencieux.
 *
 * ATOMICITÉ : crédit du pack et enregistrement de l'achat vont dans la même
 * transaction — un échec lève (500 → rejeu Stripe), rien n'est crédité à moitié.
 *
 * COMPTE STRIPE PARTAGÉ (autres applications : prix `kairo_*`, metadata app=kairo…) :
 * n'est traité que ce qui est À CORTEX — prix dont le lookup_key est un plan
 * Cortex, metadata app=cortex ou cortexUserId, plan Cortex, ou abonnement Cortex
 * déjà lié chez nous (pas le seul client : il peut payer autre chose sur ce
 * compte). Tout le reste répond 200 « ignored:foreign » : ni crédit,
 * ni reprise mémorisée, ni retry (un 500 ferait rejouer Stripe pendant des jours
 * puis désactiver l'endpoint). Le retry 500 reste réservé à un événement Cortex
 * dont l'utilisateur n'est pas encore lié.
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
  /** Format récent : la facture ne porte plus le prix, seulement son id → lookup_key via le cache des prix. */
  lookupKeyOfPrice?(priceId: string): Promise<string | null>;
  /** Format récent : la charge ne porte plus `invoice` → facture retrouvée par payment_intent (InvoicePayments). */
  invoiceByPaymentIntent?(paymentIntent: string): Promise<{ invoiceId: string } | null>;
  /** Frais Stripe réels d'un paiement (balance transaction de sa charge), en unités mineures de sa devise ; null si pas encore connus. */
  paymentDetails?(paymentIntent: string): Promise<{ feeCents: number | null } | null>;
};
export type HandleOptions = { lookup?: StripeLookup };

export type PlanKey = "pro_monthly" | "pro_yearly" | "credits_10";
export type PlanSpec = { lookupKey: string; mode: "subscription" | "payment"; credits?: number; label: string };

export const PLANS: Record<PlanKey, PlanSpec> = {
  pro_monthly: { lookupKey: "cortex_pro_monthly", mode: "subscription", label: "Pro mensuel" },
  pro_yearly: { lookupKey: "cortex_pro_yearly", mode: "subscription", label: "Pro annuel" },
  credits_10: { lookupKey: "cortex_credits_10", mode: "payment", credits: 10, label: "Pack de 10 crédits" },
};

/**
 * Les événements que `handleStripeEvent` traite : c'est la liste à cocher sur
 * l'endpoint webhook, ni plus ni moins (lib/billing/stripe-setup la pose). Ne pas
 * y ajouter invoice.created : sans réponse de l'endpoint, Stripe retarde la
 * finalisation de toutes les factures.
 */
export const HANDLED_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "invoice.paid",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
  "charge.dispute.created",
] as const;

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
export function unixToStr(unix: number | null | undefined): string | null {
  if (!unix || !Number.isFinite(unix)) return null;
  return new Date(unix * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function invoicePeriodEnd(inv: Stripe.Invoice): string | null {
  return unixToStr(subscriptionLine(inv)?.period?.end) ?? unixToStr((inv as { period_end?: number }).period_end);
}
function invoicePeriodStart(inv: Stripe.Invoice): string | null {
  return unixToStr(subscriptionLine(inv)?.period?.start) ?? unixToStr((inv as { period_start?: number }).period_start);
}

// ─────── lecture BI-FORMAT des factures (ancien format ET famille « basil » 2025+) ───────
type AnyInvoice = Stripe.Invoice & {
  subscription?: unknown; payment_intent?: unknown;
  subscription_details?: { metadata?: Record<string, string> };
  parent?: { subscription_details?: { subscription?: unknown; metadata?: Record<string, string> } | null } | null;
  payments?: { data?: Array<{ payment?: { type?: string; payment_intent?: unknown } }> };
};
type AnyLine = {
  price?: { id?: string; lookup_key?: string | null } | string | null;
  pricing?: { price_details?: { price?: string } | null } | null;
  parent?: { subscription_item_details?: { subscription?: unknown } | null } | null;
  metadata?: Record<string, string>;
};
const linesOf = (lines: unknown): AnyLine[] => (lines as { data?: AnyLine[] } | null | undefined)?.data ?? [];
/**
 * La ligne d'ABONNEMENT d'une facture, celle dont la période est la période
 * payée. Une facture peut en porter plusieurs : un changement d'offre place en
 * tête le crédit du temps non utilisé (prorata), dont la période est le
 * reliquat de l'ancienne offre. On écarte donc les lignes de prorata (signalées
 * sur la ligne dans l'ancien format, sous son parent dans le récent) et on garde
 * celle qui finit le plus tard.
 */
type PeriodLine = AnyLine & {
  proration?: boolean; period?: { start?: number; end?: number };
  parent?: { subscription_item_details?: { proration?: boolean; subscription?: unknown } | null } | null;
};
function subscriptionLine(inv: Stripe.Invoice): PeriodLine | undefined {
  const lines = linesOf(inv.lines) as PeriodLine[];
  const full = lines.filter((l) => l.proration !== true && l.parent?.subscription_item_details?.proration !== true);
  return (full.length ? full : lines).reduce<PeriodLine | undefined>(
    (latest, l) => (!latest || (l.period?.end ?? 0) > (latest.period?.end ?? 0) ? l : latest), undefined,
  );
}
/** Abonnement d'une facture : `subscription` (ancien) | parent.subscription_details | parent de la ligne (récent). */
function invoiceSubscriptionId(inv: AnyInvoice): string | null {
  return idOf(inv.subscription)
    ?? idOf(inv.parent?.subscription_details?.subscription)
    ?? idOf(linesOf(inv.lines)[0]?.parent?.subscription_item_details?.subscription);
}
/** Métadonnées de l'abonnement portées par la facture (subscription_data.metadata du checkout), ancien ou récent. */
function invoiceSubMeta(inv: AnyInvoice): Record<string, string> | undefined {
  return inv.subscription_details?.metadata ?? inv.parent?.subscription_details?.metadata ?? linesOf(inv.lines)[0]?.metadata;
}
/** PaymentIntent d'une facture : `payment_intent` (ancien) | payments.data[].payment.payment_intent (récent). */
function invoicePaymentIntent(inv: AnyInvoice): string | null {
  return idOf(inv.payment_intent)
    ?? idOf(inv.payments?.data?.find((p) => p.payment?.type === "payment_intent" || p.payment?.payment_intent)?.payment?.payment_intent);
}
/** Ids de prix des lignes (récent : pricing.price_details.price ; ancien : price.id ou price en chaîne). */
function priceIdsOf(lines: unknown): string[] {
  return linesOf(lines).map((l) => (typeof l.price === "string" ? l.price : l.price?.id) ?? l.pricing?.price_details?.price ?? "").filter(Boolean);
}
/**
 * lookup_keys des lignes : portés par la ligne (ancien format), sinon résolus
 * depuis l'id du prix par le cache des prix Cortex (récent), sinon déduits de
 * metadata.plan (nos métadonnées d'abonnement). Sans réseau en test.
 */
async function resolveLookupKeys(lines: unknown, metas: Meta[], lookup?: StripeLookup): Promise<string[]> {
  const keys = new Set(lookupKeysOf(lines));
  if (!keys.size && lookup?.lookupKeyOfPrice) {
    for (const id of priceIdsOf(lines)) {
      const k = await lookup.lookupKeyOfPrice(id).catch(() => null);
      if (k) keys.add(k);
    }
  }
  if (!keys.size) {
    for (const m of metas) if (isPlanKey(m?.plan)) keys.add(PLANS[m!.plan as PlanKey].lookupKey);
  }
  return [...keys];
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
  /** Reprise : centièmes retirés par cet événement, dont `debtCenti` en dette ; abonnement suspendu ; facture de la période en cours. */
  retiredCenti?: number; debtCenti?: number; suspended?: boolean; currentPeriod?: boolean;
};

// ─────────────────── appartenance d'un événement à Cortex ───────────────────
const CORTEX_LOOKUP_KEYS = new Set(Object.values(PLANS).map((p) => p.lookupKey));
type Meta = Record<string, string> | null | undefined;

/** metadata.app posée et différente de cortex → autre application, sans discussion. */
function metaForeign(...metas: Meta[]): boolean {
  return metas.some((m) => typeof m?.app === "string" && m.app.toLowerCase() !== "cortex");
}
/** metadata qui désigne Cortex : app=cortex, cortexUserId, ou plan Cortex. */
function metaCortex(...metas: Meta[]): boolean {
  return metas.some((m) => m?.app?.toLowerCase() === "cortex" || !!m?.cortexUserId || isPlanKey(m?.plan));
}
function lookupKeysOf(lines: unknown): string[] {
  const data = (lines as { data?: Array<{ price?: { lookup_key?: string | null } | string | null }> } | null | undefined)?.data ?? [];
  return data.map((l) => (typeof l?.price === "object" && l.price ? l.price.lookup_key ?? "" : "")).filter(Boolean);
}
const FOREIGN: HandleResult = { ok: true, action: "ignored:foreign", credited: false, reversed: false };
function foreign(kind: string, id: string | null | undefined, why: string): HandleResult {
  log("info", "stripe.foreign_event_ignored", { kind, id: id ?? null, why });
  return FOREIGN;
}

/** Traite un événement Stripe DÉJÀ vérifié. Idempotent. Lève pour un échec RETRYABLE (la route répond 500). */
export async function handleStripeEvent(event: Stripe.Event, opts: HandleOptions = {}): Promise<HandleResult> {
  if (await isProcessed(event.id)) {
    const dup: HandleResult = { ok: true, action: "duplicate", duplicate: true, credited: false, reversed: false };
    logReversalDecision(event, dup);
    return dup;
  }

  // Date de l'événement CHEZ STRIPE : elle ordonne les changements de statut (cf. credits : ordre des événements).
  const at = unixToStr(event.created);
  let res: HandleResult;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      res = await onCheckout(event.data.object as Stripe.Checkout.Session, event.id, at, event.livemode, opts.lookup);
      break;
    case "invoice.paid":
      res = await onInvoicePaid(event.data.object as Stripe.Invoice, opts.lookup, at);
      break;
    case "customer.subscription.updated":
      res = await onSubscriptionUpdated(event.data.object as Stripe.Subscription, opts.lookup, at);
      break;
    case "customer.subscription.deleted":
      res = await onSubscriptionDeleted(event.data.object as Stripe.Subscription, opts.lookup, at);
      break;
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const { paymentIntent, amountCents, totalCents } = reversalAmounts(event)!;
      res = await reverseByPaymentIntent(paymentIntent, "remboursement Stripe", {
        amountCents, totalCents,
        metadata: charge.metadata ?? null, customerId: idOf(charge.customer), lookup: opts.lookup, livemode: event.livemode,
      });
      // Revenu : le remboursé cumulé s'impute au paiement (même s'il n'est pas encore arrivé chez nous).
      if (res.ok && res.action !== FOREIGN.action) {
        await linkInvoicePaymentIntent(paymentIntent);
        await recordRefund(paymentIntent, Number(charge.amount_refunded ?? 0));
      }
      break;
    }
    case "charge.dispute.created": {
      const dispute = event.data.object as Stripe.Dispute;
      const charge = typeof dispute.charge === "object" && dispute.charge ? (dispute.charge as Stripe.Charge) : null;
      const { paymentIntent, amountCents } = reversalAmounts(event)!;
      res = await reverseByPaymentIntent(paymentIntent, "litige Stripe", {
        amountCents,
        metadata: charge?.metadata ?? null, customerId: idOf(charge?.customer), lookup: opts.lookup, livemode: event.livemode,
      });
      if (res.ok && res.action !== FOREIGN.action) {
        await linkInvoicePaymentIntent(paymentIntent);
        await recordDispute(paymentIntent, Number(dispute.amount ?? 0), disputeFeeCents(dispute));
      }
      break;
    }
    default:
      res = { ok: true, action: `ignored:${event.type}` };
  }
  // Marqué APRÈS succès : un échec transitoire laisse Stripe réessayer.
  if (res.ok) await markProcessed(event.id);
  logReversalDecision(event, res);
  return res;
}

/**
 * Montants d'un remboursement (cumul `amount_refunded` sur le montant de la
 * charge) ou d'un litige (montant contesté, sans total : tout est repris). null
 * pour un autre événement.
 */
function reversalAmounts(event: Stripe.Event): { paymentIntent: string | null; amountCents: number | null; totalCents: number | null } | null {
  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    return {
      paymentIntent: idOf(charge.payment_intent),
      amountCents: Number(charge.amount_refunded ?? charge.amount ?? 0) || null,
      totalCents: Number(charge.amount ?? 0) || null,
    };
  }
  if (event.type === "charge.dispute.created") {
    const dispute = event.data.object as Stripe.Dispute;
    return { paymentIntent: idOf(dispute.payment_intent), amountCents: Number(dispute.amount ?? 0) || null, totalCents: null };
  }
  return null;
}

/**
 * Une ligne par décision de reprise (ignoré, doublon, retiré, mémorisé…), avec
 * les montants. Identifiants Stripe du paiement et de l'événement seulement :
 * ni utilisateur, ni client, ni e-mail.
 */
function logReversalDecision(event: Stripe.Event, res: HandleResult): void {
  const amounts = reversalAmounts(event);
  if (!amounts) return;
  log("info", "stripe.reversal_decision", {
    type: event.type, eventId: event.id, ...amounts, decision: res.action,
    retiredCenti: res.retiredCenti ?? 0, debtCenti: res.debtCenti ?? 0, suspended: !!res.suspended, currentPeriod: res.currentPeriod ?? null,
  });
}

/** Ids `promo_…` dont une session à 0 € crédite quand même le pack (STRIPE_FREE_PROMO_CODES, séparés par des virgules). */
export function freePromoCodes(): Set<string> {
  return new Set((process.env.STRIPE_FREE_PROMO_CODES ?? "").split(",").map((c) => c.trim()).filter((c) => c.startsWith("promo_")));
}

/** Le code promo de la session s'il est sur la liste blanche, sinon null. Seul un code créé dans le tableau de bord porte un id promo_. */
function allowedFreePromo(s: Stripe.Checkout.Session): string | null {
  const allowed = freePromoCodes();
  if (!allowed.size) return null;
  for (const d of s.discounts ?? []) {
    const id = idOf(d.promotion_code);
    if (id && allowed.has(id)) return id;
  }
  return null;
}

/** Frais de litige portés par le litige (ses balance transactions, dans sa devise), sinon null → estimés. */
export function disputeFeeCents(d: Stripe.Dispute): number | null {
  const bts = (d.balance_transactions ?? []).filter((b) => typeof b === "object" && b && (!b.currency || !d.currency || b.currency === d.currency));
  return bts.length ? bts.reduce((sum, b) => sum + Math.max(0, Number(b.fee ?? 0)), 0) : null;
}

/**
 * Frais réels d'un paiement demandés à Stripe. Jamais bloquant : Stripe
 * injoignable ou frais pas encore connus → null (frais estimés, remplacés par la
 * reprise de l'historique). Un crédit payé ne dépend pas de cette lecture.
 */
async function realFeeCents(lookup: StripeLookup | undefined, pi: string | null): Promise<number | null> {
  if (!lookup?.paymentDetails || !pi) return null;
  try {
    return (await lookup.paymentDetails(pi))?.feeCents ?? null;
  } catch (e) {
    log("warn", "stripe.fee_lookup_failed", { paymentIntent: pi, error: String(e).slice(0, 160) });
    return null;
  }
}

/** Taxe collectée sur une facture (ancien format : `tax` ; récent : `total_taxes[]`). */
export function invoiceTaxCents(inv: object): number {
  const old = Number((inv as { tax?: number | null }).tax ?? NaN);
  if (Number.isFinite(old)) return Math.max(0, old);
  const list = (inv as { total_taxes?: Array<{ amount?: number }> | null }).total_taxes ?? [];
  return list.reduce((sum, t) => sum + Math.max(0, Number(t.amount ?? 0)), 0);
}

async function onCheckout(s: Stripe.Checkout.Session, eventId: string, at: string | null, livemode: boolean, lookup?: StripeLookup): Promise<HandleResult> {
  const userId = s.metadata?.cortexUserId ?? null;
  const plan = s.metadata?.plan ?? null;
  // À Cortex seulement : plan Cortex ou cortexUserId (et jamais une autre app déclarée).
  if (metaForeign(s.metadata) || !(isPlanKey(plan) || userId)) {
    return foreign("checkout.session", s.id, metaForeign(s.metadata) ? `app=${s.metadata?.app}` : "ni plan Cortex ni cortexUserId");
  }

  if (s.mode === "subscription") {
    if (!userId) return { ok: false, action: "checkout-sub", error: "cortexUserId manquant" };
    // Pas de crédit ici : c'est invoice.paid qui attribue. On lie client → utilisateur.
    await linkSubscription({ userId, customerId: idOf(s.customer), subscriptionId: idOf(s.subscription), plan, at });
    return { ok: true, action: "subscription-linked" };
  }

  // Pack : crédité seulement si de l'argent a RÉELLEMENT été encaissé — moyen
  // différé → async_payment_succeeded ; session gratuite (no_payment_required,
  // coupon 100 %, montant 0) → pas de crédit, SAUF code promo de la liste
  // blanche STRIPE_FREE_PROMO_CODES (vide par défaut : refus inchangé).
  const amount = s.amount_total == null ? null : Number(s.amount_total);
  const free = s.payment_status === "no_payment_required" || amount === 0;
  if (s.payment_status !== "paid" || (amount !== null && !(amount > 0))) {
    const promo = free ? allowedFreePromo(s) : null;
    if (!promo) {
      if (free) log("warn", "stripe.free_session_ignored", { session: s.id, status: s.payment_status, amount });
      return { ok: true, action: "pack-unpaid", credited: false };
    }
    log("info", "stripe.free_session_allowed", { session: s.id, promotionCode: promo });
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
  // Frais réels lus AVANT la transaction (réseau), seulement pour un achat pas encore crédité.
  const fee = amount && amount > 0 && !(await authGet<{ id: number }>(`SELECT id FROM credit_transactions WHERE ref = ?`, ref))
    ? await realFeeCents(lookup, pi) : null;
  // Crédit + enregistrement de l'achat ET du montant encaissé dans UNE transaction : un
  // échec lève (rien de crédité, 500 → Stripe rejoue) ; le ref UNIQUE tranche une course.
  const credited = await authTx(async (tx) => {
    if (await tx.get<{ id: number }>(`SELECT id FROM credit_transactions WHERE ref = ?`, ref)) return false;
    await tx.run(
      `INSERT INTO credit_transactions (user_id, delta, reason, ref, unit, created_at) VALUES (?,?,?,?,'centi',?)`,
      userId, centi, `achat ${plan ?? "pack"}`, ref, nowStr(),
    );
    await tx.run(
      `INSERT INTO stripe_purchases (session_id, payment_intent, user_id, credits_centi, livemode, created_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT (session_id) DO NOTHING`,
      s.id, pi, userId, centi, livemode ? 1 : 0, nowStr(),
    );
    if (amount && amount > 0) {
      await recordPayment({
        sourceId: s.id, kind: "pack", paymentIntent: pi, userId, currency: s.currency ?? "eur", amountCents: amount,
        taxCents: Number(s.total_details?.amount_tax ?? 0), feeCents: fee, livemode, paidAt: at,
      }, tx);
    }
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
      log("info", "stripe.orphan_reversal_applied", { paymentIntent: pi, retiredCenti: reversed ? take : 0 });
      return { ok: true, action: "pack-credited-then-reversed", credited, reversed };
    }
  }
  return { ok: true, action: "pack-credited", credited };
}

async function onInvoicePaid(invoice: Stripe.Invoice, lookup: StripeLookup | undefined, at: string | null): Promise<HandleResult> {
  const inv = invoice as AnyInvoice;
  const subId = invoiceSubscriptionId(inv);
  if (!subId) return { ok: true, action: "invoice-non-subscription" };
  const subMeta = invoiceSubMeta(inv);
  const invCustomer = idOf(inv.customer);
  if (metaForeign(inv.metadata as Meta, subMeta)) return foreign("invoice", inv.id, `app=${(inv.metadata as Meta)?.app ?? subMeta?.app}`);
  const keys = await resolveLookupKeys(inv.lines, [inv.metadata as Meta, subMeta], lookup);
  const cortexPrice = keys.some((k) => CORTEX_LOOKUP_KEYS.has(k));
  if (!cortexPrice && !metaCortex(inv.metadata as Meta, subMeta)) {
    // Ni prix Cortex ni métadonnée Cortex : seul l'abonnement Cortex DÉJÀ lié chez nous rattache la facture.
    // Pas le client : sur le compte partagé, un abonné Cortex peut aussi être facturé pour autre chose.
    const linked = (await authGet<{ user_id: string }>(`SELECT user_id FROM subscriptions WHERE subscription_id = ?`, subId))?.user_id;
    if (!linked) return foreign("invoice", inv.id, `prix ${(keys.length ? keys : priceIdsOf(inv.lines)).join(",") || "?"} inconnu, abonnement non lié`);
  }
  // Idempotence par FACTURE : une facture n'attribue qu'un mois, quel que soit l'événement qui la porte.
  if (inv.id && (await authGet<{ invoice_id: string }>(`SELECT invoice_id FROM stripe_invoices WHERE invoice_id = ?`, inv.id))) {
    return { ok: true, action: "invoice-duplicate", duplicate: true };
  }
  const customerId = invCustomer;
  let userId = customerId ? await resolveUserByCustomer(customerId) : null;
  if (!userId) userId = subMeta?.cortexUserId ?? (inv.metadata?.cortexUserId as string | undefined) ?? null;
  // Introuvable → on LÈVE (500) pour que Stripe réessaie : le checkout qui lie
  // client → utilisateur peut arriver après la facture.
  if (!userId) throw new Error(`invoice.paid : utilisateur introuvable (customer ${customerId ?? "?"}) — retry`);
  const periodEnd = invoicePeriodEnd(inv);
  if (!periodEnd) throw new Error(`invoice.paid : période introuvable (sub ${subId}) — retry`);
  const lineKeys = await resolveLookupKeys({ data: [subscriptionLine(inv)].filter(Boolean) }, [], lookup);
  const plan = [...lineKeys, ...keys].find((k) => CORTEX_LOOKUP_KEYS.has(k)) ?? keys[0] ?? null;
  const previous = await getSubscription(userId);
  const granted = await grantSubscriptionMonth({ userId, customerId, subscriptionId: subId, plan, periodEnd, periodStart: invoicePeriodStart(inv), at });
  if (granted && previous?.period_end && previous.period_end !== periodEnd) {
    // La période précédente est close : ce qu'il en reste expire sans servir (non reportable).
    // Retenu sur SA facture : un remboursement ultérieur de celle-ci l'absorbe avant toute dette.
    await authRun(
      `UPDATE stripe_invoices SET unused_centi = ? WHERE user_id = ? AND period_end = ? AND unused_centi IS NULL`,
      Math.max(0, Number(previous.remaining) || 0), userId, previous.period_end,
    );
  }
  if (inv.id) {
    // Montant encaissé : compté même si la facture n'accorde rien (période plus ancienne), l'argent est là.
    const paid = Number((inv as { amount_paid?: number }).amount_paid ?? 0);
    const invPi = invoicePaymentIntent(inv);
    if (paid > 0) {
      await recordPayment({
        sourceId: inv.id, kind: "subscription", paymentIntent: invPi, userId, currency: inv.currency ?? "eur", amountCents: paid,
        taxCents: invoiceTaxCents(inv), feeCents: await realFeeCents(lookup, invPi), livemode: !!inv.livemode, paidAt: at,
      });
    }
    // Enregistrée même si elle n'accorde rien (période plus ancienne) : idempotence et reprise s'y rattachent.
    await authRun(
      `INSERT INTO stripe_invoices (invoice_id, subscription_id, customer_id, payment_intent, user_id, granted_centi, period_end, created_at)
       VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (invoice_id) DO NOTHING`,
      inv.id, subId, customerId, invoicePaymentIntent(inv), userId,
      granted ? subscriptionMonthlyCreditsCenti() : 0, periodEnd, nowStr(),
    );
  }
  return { ok: true, action: granted ? "subscription-granted" : "invoice-older-period" };
}

/** Abonnement Stripe à Cortex ? prix Cortex, métadonnée Cortex, ou déjà lié chez nous. */
async function subscriptionIsCortex(sub: Stripe.Subscription, lookup?: StripeLookup): Promise<false | string> {
  if (metaForeign(sub.metadata as Meta)) return `app=${(sub.metadata as Meta)?.app}`;
  if (metaCortex(sub.metadata as Meta)) return false;
  const keys = await resolveLookupKeys(sub.items, [], lookup);
  if (keys.some((k) => CORTEX_LOOKUP_KEYS.has(k))) return false;
  // L'abonnement Cortex déjà lié, pas le seul client : sur le compte partagé, un abonné peut en avoir un autre.
  const linked = (await authGet<{ user_id: string }>(`SELECT user_id FROM subscriptions WHERE subscription_id = ?`, sub.id))?.user_id;
  return linked ? false : `prix ${(keys.length ? keys : priceIdsOf(sub.items)).join(",") || "?"} inconnu, abonnement non lié`;
}

async function onSubscriptionUpdated(sub: Stripe.Subscription, lookup: StripeLookup | undefined, at: string | null): Promise<HandleResult> {
  const why = await subscriptionIsCortex(sub, lookup);
  if (why) return foreign("subscription", sub.id, why);
  // Seul le STATUT est repris. La période que porte l'événement est celle que
  // Stripe ANNONCE : au renouvellement il l'avance une heure avant de tenter le
  // paiement, et la laisse avancée si le paiement échoue. La période qui donne
  // des crédits est la période PAYÉE, écrite par invoice.paid et par lui seul.
  // Résiliation programmée : l'abonnement reste en règle jusqu'à la fin de la
  // période payée (le vrai arrêt vient de .deleted) ; on la retient pour l'écran.
  const canceling = !!sub.cancel_at_period_end || (typeof sub.cancel_at === "number" && sub.cancel_at > 0);
  await setSubscriptionStatus({ subscriptionId: sub.id, customerId: idOf(sub.customer), status: sub.status, at, cancelAtPeriodEnd: canceling });
  return { ok: true, action: "subscription-updated" };
}

async function onSubscriptionDeleted(sub: Stripe.Subscription, lookup: StripeLookup | undefined, at: string | null): Promise<HandleResult> {
  const why = await subscriptionIsCortex(sub, lookup);
  if (why) return foreign("subscription", sub.id, why);
  // Le solde du mois va être effacé sans avoir servi : retenu sur la facture de la période,
  // qu'un remboursement ultérieur absorbe avant toute dette (résilier puis rembourser).
  const row = await authGet<{ user_id: string; remaining: number; period_end: string | null }>(
    `SELECT user_id, remaining, period_end FROM subscriptions WHERE subscription_id = ?`, sub.id,
  );
  if (row?.period_end) {
    await authRun(
      `UPDATE stripe_invoices SET unused_centi = ? WHERE user_id = ? AND period_end = ? AND unused_centi IS NULL`,
      Math.max(0, Number(row.remaining) || 0), row.user_id, row.period_end,
    );
  }
  await setSubscriptionStatus({ subscriptionId: sub.id, customerId: idOf(sub.customer), status: "canceled", at, cancelAtPeriodEnd: false, clearRemaining: true });
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
  lookup?: StripeLookup;
  livemode?: boolean;
};

type InvoiceRow = {
  invoice_id: string; user_id: string; granted_centi: number; period_end: string | null;
  reversed_centi: number | null; unused_centi: number | null;
};
const INVOICE_COLS = `invoice_id, user_id, granted_centi, period_end, reversed_centi, unused_centi`;

/**
 * Reprise d'une facture d'ABONNEMENT (remboursement, litige), pour la seule
 * période de CETTE facture et au prorata de la part remboursée : cumul Stripe
 * `amount_refunded` / montant de la charge (un litige reprend tout). La part
 * reprise absorbe d'abord ce qui reste des crédits de cette période : le solde
 * du mois si c'est la facture en cours, le reliquat expiré inutilisé si elle est
 * plus ancienne (les crédits du mois en cours, payé, n'y sont pour rien). Seul
 * le consommé passe en dette dans le ledger. Seul un remboursement TOTAL de la
 * facture en cours suspend l'abonnement, jusqu'à la prochaine facture payée.
 * Cumul gardé sur la facture (`reversed_centi`), sous verrou du paiement : un
 * rejeu, ou un autre événement au même cumul, ne reprend jamais deux fois.
 * Hors période en règle (échéance passée, impayé), on lit le compteur de la
 * ligne, qui garde ce qui n'a pas été dépensé.
 */
async function reverseInvoice(invoice: InvoiceRow, paymentIntent: string, why: string, ref: string, ctx: ReversalContext): Promise<HandleResult> {
  const granted = Math.max(0, Number(invoice.granted_centi) || 0);
  const partial = !!(ctx.amountCents && ctx.totalCents && ctx.amountCents < ctx.totalCents);
  const target = partial ? Math.min(granted, Math.ceil((granted * ctx.amountCents!) / ctx.totalCents!)) : granted;
  const sub = await getSubscription(invoice.user_id);
  const current = !!sub && !!invoice.period_end && sub.period_end === invoice.period_end;
  // Recharge paresseuse de l'annuel posée AVANT la transaction : `remaining` vaut alors le solde utilisable.
  if (current && subscriptionLive(sub)) await subscriptionCreditsCenti(invoice.user_id);
  await ensureLedgerUnit();
  const step = await authTx(async (tx) => {
    if (dbDriverName() === "postgres") await tx.run(`SELECT pg_advisory_xact_lock(hashtext(?))`, `reversal:${paymentIntent}`);
    const row = await tx.get<{ reversed_centi: number | null; unused_centi: number | null }>(
      `SELECT reversed_centi, unused_centi FROM stripe_invoices WHERE invoice_id = ?`, invoice.invoice_id,
    );
    const already = Math.max(0, Number(row?.reversed_centi) || 0);
    const take = target - already;
    if (take <= 0) return null;
    const suspend = current && !partial && granted > 0;
    // Ce qui reste de la période : le solde du mois (facture en cours), puis le reliquat
    // retenu à sa clôture (renouvellement, résiliation). Seul le reste est du consommé.
    const fromBalance = current ? await withdrawSubscriptionInTx(tx, invoice.user_id, take, suspend) : 0;
    const unused = Math.max(0, Number(row?.unused_centi) || 0);
    const fromUnused = Math.min(take - fromBalance, unused);
    const debt = take - fromBalance - fromUnused;
    await tx.run(
      `UPDATE stripe_invoices SET reversed_centi = ?, unused_centi = ? WHERE invoice_id = ?`,
      target, row?.unused_centi == null ? null : unused - fromUnused, invoice.invoice_id,
    );
    // Ligne du ledger à chaque étape (dette, 0 si tout a été absorbé) : trace lisible, et ref
    // `stripe:reversal:<pi>` une fois tout repris d'un coup (les autres chemins s'y arrêtent).
    await tx.run(
      `INSERT INTO credit_transactions (user_id, delta, reason, ref, unit, created_at) VALUES (?,?,?,?,'centi',?)`,
      invoice.user_id, debt > 0 ? -debt : 0, partial ? `${why} (abonnement, partiel : ${ctx.amountCents}/${ctx.totalCents} centimes)` : `${why} (abonnement)`,
      already === 0 && target === granted ? ref : `${ref}:${target}`, nowStr(),
    );
    return { take, debt, suspend };
  }).catch((e) => {
    if (/unique|constraint/i.test(String(e))) return null; // course perdue sur le ref : l'autre a repris
    throw e;
  });
  if (!step) return { ok: true, action: granted > 0 ? "reversal-duplicate" : "invoice-nothing-granted", reversed: false };
  return {
    ok: true, action: "invoice-reversed", reversed: true,
    retiredCenti: step.take, debtCenti: step.debt, suspended: step.suspend, currentPeriod: current,
  };
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
    const retired = await authTx(async (tx) => {
      if (dbDriverName() === "postgres") await tx.run(`SELECT pg_advisory_xact_lock(hashtext(?))`, `reversal:${paymentIntent}`);
      const done = await tx.get<{ total: number | string | null }>(
        `SELECT coalesce(sum(-(${DELTA_CENTI})), 0) total FROM credit_transactions WHERE user_id = ? AND ref LIKE ?`,
        purchase.user_id, `${ref}%`,
      );
      const already = Number(done?.total ?? 0);
      const take = target - already;
      if (take <= 0) return 0;
      const stepRef = already === 0 && take === full ? ref : `${ref}:${target}`;
      await tx.run(
        `INSERT INTO credit_transactions (user_id, delta, reason, ref, unit, created_at) VALUES (?,?,?,?,'centi',?)`,
        purchase.user_id, -take, target < full ? `${why} (partiel : ${ctx.amountCents}/${ctx.totalCents} centimes)` : why, stepRef, nowStr(),
      );
      return take;
    }).catch((e) => {
      if (/unique|constraint/i.test(String(e))) return 0; // course perdue sur le ref : l'autre a repris
      throw e;
    });
    return { ok: true, action: retired ? "pack-reversed" : "reversal-duplicate", reversed: retired > 0, retiredCenti: retired };
  }
  if (await authGet<{ id: number }>(`SELECT id FROM credit_transactions WHERE ref = ?`, ref)) {
    return { ok: true, action: "reversal-duplicate", reversed: false };
  }
  let invoice = await authGet<InvoiceRow>(`SELECT ${INVOICE_COLS} FROM stripe_invoices WHERE payment_intent = ?`, paymentIntent);
  if (!invoice && ctx.lookup?.invoiceByPaymentIntent) {
    // Format récent : la charge ne porte plus `invoice` et la facture n'avait pas
    // forcément de payment_intent à l'arrivée → Stripe sait quelle facture ce paiement règle.
    let found: { invoiceId: string } | null = null;
    try { found = await ctx.lookup.invoiceByPaymentIntent(paymentIntent); }
    catch (e) { throw new Error(`Stripe injoignable pour retrouver la facture de ${paymentIntent} — retry (${String(e).slice(0, 120)})`); }
    if (found) {
      invoice = await authGet<InvoiceRow>(`SELECT ${INVOICE_COLS} FROM stripe_invoices WHERE invoice_id = ?`, found.invoiceId);
      if (invoice) await authRun(`UPDATE stripe_invoices SET payment_intent = coalesce(payment_intent, ?) WHERE invoice_id = ?`, paymentIntent, found.invoiceId);
    }
  }
  if (invoice) return reverseInvoice(invoice, paymentIntent, why, ref, ctx);
  // Compte partagé : au-delà des correspondances EXACTES ci-dessus (achat, facture
  // connus chez nous), une charge d'une autre application n'est pas à nous.
  if (metaForeign(ctx.metadata)) return foreign("charge", paymentIntent, `app=${ctx.metadata?.app}`);
  // 3) Achat antérieur à `stripe_purchases` : Stripe sait quelle session porte ce paiement.
  if (ctx.lookup) {
    let session: Awaited<ReturnType<StripeLookup["sessionByPaymentIntent"]>> = null;
    try { session = await ctx.lookup.sessionByPaymentIntent(paymentIntent); }
    catch (e) { throw new Error(`Stripe injoignable pour retrouver la session de ${paymentIntent} — retry (${String(e).slice(0, 120)})`); }
    if (session?.userId && session.credits) {
      const centi = toCenti(session.credits);
      await authRun(
        `INSERT INTO stripe_purchases (session_id, payment_intent, user_id, credits_centi, livemode, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT (session_id) DO NOTHING`,
        session.id, paymentIntent, session.userId, centi, ctx.livemode ? 1 : 0, nowStr(),
      );
      const reversed = await addTransaction(session.userId, -centi, `${why} (achat retrouvé via Stripe)`, ref);
      return { ok: true, action: "pack-reversed", reversed, retiredCenti: reversed ? centi : 0 };
    }
  }
  // Compte partagé avec l'activité freelance (Payment Links, sans métadonnée) : une
  // charge qui ne porte pas la marque Cortex n'est pas à nous, même si son client ou
  // son e-mail correspond à un compte Cortex. Ni reprise, ni mémorisation.
  if (!metaCortex(ctx.metadata)) return foreign("charge", paymentIntent, "aucune métadonnée Cortex, paiement inconnu");
  // 4) Métadonnées portées par la charge (payment_intent_data) ; 5) client déjà lié. Montant → crédits au prix du pack.
  // Jamais l'e-mail : il ne prouve pas que le paiement est un achat Cortex.
  const metaUser = ctx.metadata?.cortexUserId ?? null;
  const metaCredits = Number(ctx.metadata?.credits ?? 0);
  const userId = metaUser ?? (ctx.customerId ? await resolveUserByCustomer(ctx.customerId) : null);
  if (userId && ctx.amountCents && ctx.amountCents > 0) {
    // Remboursement partiel : au prorata du montant ; sinon, crédits des métadonnées si le montant couvre tout.
    const centi = creditsCentiForAmount(ctx.amountCents);
    const capped = metaCredits > 0 ? Math.min(centi, toCenti(metaCredits)) : centi;
    const reversed = await addTransaction(userId, -capped, `${why} (${ctx.amountCents} centimes → crédits)`, ref);
    log("warn", "stripe.reversal_by_amount", { paymentIntent, amountCents: ctx.amountCents, centi: capped });
    return { ok: true, action: "pack-reversed-by-amount", reversed, retiredCenti: reversed ? capped : 0 };
  }
  // 6) Rien d'exploitable sur une charge Cortex → on MÉMORISE (appliquée si l'achat
  // arrive ensuite) et on le dit fort.
  await authRun(
    `INSERT INTO stripe_orphan_reversals (payment_intent, why, amount_cents, created_at) VALUES (?,?,?,?) ON CONFLICT (payment_intent) DO NOTHING`,
    paymentIntent, why, ctx.amountCents ?? null, nowStr(),
  );
  log("error", "stripe.reversal_unresolved", { paymentIntent, why, amountCents: ctx.amountCents ?? null });
  return { ok: true, action: "reversal-orphaned", reversed: false, error: `paiement inconnu (${paymentIntent}) : reprise mémorisée, à contrôler dans Stripe` };
}
