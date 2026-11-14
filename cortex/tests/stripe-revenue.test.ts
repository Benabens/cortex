/**
 * REVENU ENCAISSÉ — ce que chaque compte a VRAIMENT payé sur Stripe, net de
 * frais, taxes, remboursements et litiges. C'est la base du budget IA par compte
 * (règle de Ben : ce que Cortex dépense en IA pour un compte reste inférieur à
 * ce que ce compte a payé, net).
 *
 * Prouve : pack payé → montant, devise, frais réels (lookup) ; Stripe injoignable
 * → frais ESTIMÉS (prudents) et les crédits sont quand même attribués ; taxe
 * déduite ; remboursements partiels CUMULÉS (jamais additionnés deux fois, un
 * événement ancien livré en retard ne fait pas baisser le remboursé) ; litige
 * avec ses frais ; remboursement + litige du même paiement plafonnés au montant ;
 * facture d'abonnement ; rejeu sous un autre event.id sans double compte ;
 * fenêtre de 12 mois glissants ; devise inconnue → 0 (prudent) ; charge d'une
 * autre application → rien.
 *
 * Seams : handleStripeEvent(event, { lookup }) et revenue.accountRevenue(userId).
 * Store Postgres/PGlite en mémoire, aucun réseau (lookup simulé).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "0";
process.env.DAILY_GEN_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.MAX_ACTIVE_JOBS = "unlimited";
process.env.FX_USD_JSON = JSON.stringify({ eur: 1.1, usd: 1 });
process.env.STRIPE_FEE_PERCENT = "3.25";
process.env.STRIPE_FEE_FIXED_CENTS = "25";
process.env.STRIPE_DISPUTE_FEE_CENTS = "2000";

let handleStripeEvent: typeof import("../lib/billing/stripe-events").handleStripeEvent;
type Lookup = import("../lib/billing/stripe-events").StripeLookup;
let revenue: typeof import("../lib/billing/revenue");
let credits: typeof import("../lib/billing/credits");

before(async () => {
  ({ handleStripeEvent } = await import("../lib/billing/stripe-events"));
  revenue = await import("../lib/billing/revenue");
  credits = await import("../lib/billing/credits");
});

after(() => {
  for (const k of ["DB_DRIVER", "DATABASE_URL", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_GEN_QUOTA", "RATE_LIMIT_PER_USER_MIN",
    "MAX_ACTIVE_JOBS", "FX_USD_JSON", "STRIPE_FEE_PERCENT", "STRIPE_FEE_FIXED_CENTS", "STRIPE_DISPUTE_FEE_CENTS"]) delete process.env[k];
});

const DAY = 86400;
const nowUnix = () => Math.floor(Date.now() / 1000);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (id: string, type: string, object: unknown, created = nowUnix()): any => ({ id, type, created, livemode: false, data: { object } });

const pack = (id: string, user: string, opts: { amount?: number; tax?: number; currency?: string; created?: number } = {}) =>
  ev(`evt_${id}`, "checkout.session.completed", {
    id: `cs_${id}`, mode: "payment", payment_status: "paid", payment_intent: `pi_${id}`,
    amount_total: opts.amount ?? 900, currency: opts.currency ?? "eur", total_details: { amount_tax: opts.tax ?? 0 },
    metadata: { cortexUserId: user, plan: "credits_10", credits: "10" },
  }, opts.created);
const refunded = (evtId: string, pi: string, amountRefunded: number, amount = 900) =>
  ev(evtId, "charge.refunded", { id: `ch_${pi}`, payment_intent: pi, amount, amount_refunded: amountRefunded, metadata: {} });
const disputed = (evtId: string, pi: string, amount: number, fee: number | null) =>
  ev(evtId, "charge.dispute.created", {
    id: `dp_${evtId}`, payment_intent: pi, amount, currency: "eur",
    balance_transactions: fee == null ? [] : [{ amount: -amount - fee, fee, currency: "eur" }],
  });

/** Stripe simulé : frais réels par payment_intent (null → absent chez Stripe). */
function lookupWithFees(fees: Record<string, number | null>, opts: { fail?: boolean } = {}): Lookup {
  return {
    async sessionByPaymentIntent() { return null; },
    async paymentDetails(pi: string) {
      if (opts.fail) throw new Error("ECONNRESET");
      if (!(pi in fees)) return null;
      return { feeCents: fees[pi] };
    },
  };
}

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test("pack payé : montant, devise et frais RÉELS de Stripe → revenu net converti en dollars", async () => {
  const r = await handleStripeEvent(pack("a1", "ua"), { lookup: lookupWithFees({ pi_a1: 38 }) });
  assert.equal(r.credited, true);
  const rev = await revenue.accountRevenue("ua");
  assert.equal(rev.payments, 1);
  assert.equal(rev.estimatedFees, 0);
  near(rev.grossUsd, 9.9);               // 900 centimes d'euro × 1,1
  near(rev.netUsd, (900 - 38) * 1.1 / 100); // 9,482 $
});

test("Stripe injoignable : crédits quand même attribués, frais ESTIMÉS (3,25 % + 25 c, arrondis au centime supérieur)", async () => {
  const r = await handleStripeEvent(pack("b1", "ub"), { lookup: lookupWithFees({}, { fail: true }) });
  assert.equal(r.credited, true);
  assert.equal(await credits.getBalanceCenti("ub"), 1000);
  const rev = await revenue.accountRevenue("ub");
  assert.equal(rev.estimatedFees, 1);
  // 3,25 % de 900 = 29,25 → 30 ; + 25 = 55 centimes.
  near(rev.netUsd, (900 - 55) * 1.1 / 100);
});

test("taxe collectée : déduite du revenu (elle n'est pas à Ben)", async () => {
  await handleStripeEvent(pack("c1", "uc", { amount: 1080, tax: 180 }), { lookup: lookupWithFees({ pi_c1: 40 }) });
  near((await revenue.accountRevenue("uc")).netUsd, (1080 - 180 - 40) * 1.1 / 100);
});

test("remboursements partiels CUMULÉS : 300 puis 500 cumulés = 500 remboursés, rejeu et événement en retard sans effet", async () => {
  await handleStripeEvent(pack("d1", "ud"), { lookup: lookupWithFees({ pi_d1: 38 }) });
  await handleStripeEvent(refunded("evt_d1_r1", "pi_d1", 300));
  await handleStripeEvent(refunded("evt_d1_r2", "pi_d1", 500));
  await handleStripeEvent(refunded("evt_d1_r2", "pi_d1", 500));   // même événement rejoué
  await handleStripeEvent(refunded("evt_d1_r1b", "pi_d1", 300));  // ancien état, livré en retard
  const rev = await revenue.accountRevenue("ud");
  // Le remboursé est déduit, taxe au prorata (0 ici) ; les frais restent dus à Stripe.
  near(rev.netUsd, (900 - 500 - 38) * 1.1 / 100);
});

test("remboursement TOTAL : le revenu net devient négatif des frais (Stripe les garde)", async () => {
  await handleStripeEvent(pack("e1", "ue"), { lookup: lookupWithFees({ pi_e1: 38 }) });
  await handleStripeEvent(refunded("evt_e1_r", "pi_e1", 900));
  near((await revenue.accountRevenue("ue")).netUsd, -38 * 1.1 / 100);
});

test("litige : montant contesté ET frais de litige déduits ; remboursement + litige plafonnés au montant payé", async () => {
  await handleStripeEvent(pack("f1", "uf"), { lookup: lookupWithFees({ pi_f1: 38 }) });
  await handleStripeEvent(disputed("evt_f1_d", "pi_f1", 900, 2000));
  near((await revenue.accountRevenue("uf")).netUsd, (0 - 38 - 2000) * 1.1 / 100);

  await handleStripeEvent(pack("f2", "uf2"), { lookup: lookupWithFees({ pi_f2: 38 }) });
  await handleStripeEvent(refunded("evt_f2_r", "pi_f2", 900));
  await handleStripeEvent(disputed("evt_f2_d", "pi_f2", 900, null)); // frais inconnus → estimés (20 €)
  // Perdu : 900 (pas 1 800) ; frais : 38 + 2 000 estimés.
  near((await revenue.accountRevenue("uf2")).netUsd, (0 - 38 - 2000) * 1.1 / 100);
});

test("facture d'abonnement payée : enregistrée une fois, même sous un autre event.id", async () => {
  const inv = (evtId: string) => ev(evtId, "invoice.paid", {
    id: "in_g1", customer: "cus_ug", subscription: "sub_ug", payment_intent: "pi_g1",
    amount_paid: 1490, currency: "eur", tax: 0,
    subscription_details: { metadata: { app: "cortex", cortexUserId: "ug" } },
    lines: { data: [{ period: { start: nowUnix(), end: nowUnix() + 30 * DAY }, price: { lookup_key: "cortex_pro_monthly" } }] },
  });
  await handleStripeEvent(inv("evt_g1"), { lookup: lookupWithFees({ pi_g1: 47 }) });
  await handleStripeEvent(inv("evt_g1_bis"), { lookup: lookupWithFees({ pi_g1: 47 }) });
  const rev = await revenue.accountRevenue("ug");
  assert.equal(rev.payments, 1);
  near(rev.netUsd, (1490 - 47) * 1.1 / 100);
});

test("12 mois glissants : un paiement de plus d'un an ne compte plus", async () => {
  await handleStripeEvent(pack("h1", "uh", { created: nowUnix() - 400 * DAY }), { lookup: lookupWithFees({ pi_h1: 38 }) });
  await handleStripeEvent(pack("h2", "uh"), { lookup: lookupWithFees({ pi_h2: 38 }) });
  const rev = await revenue.accountRevenue("uh");
  assert.equal(rev.payments, 1);
  near(rev.netUsd, (900 - 38) * 1.1 / 100);
});

test("devise sans taux connu → 0 $ (prudent : jamais de budget sur un montant non converti)", async () => {
  await handleStripeEvent(pack("i1", "ui", { currency: "gbp" }), { lookup: lookupWithFees({ pi_i1: 38 }) });
  const rev = await revenue.accountRevenue("ui");
  assert.equal(rev.payments, 1);
  assert.equal(rev.netUsd, 0);
  assert.deepEqual(rev.unconverted, ["gbp"]);
});

test("charge d'une autre application, ou paiement inconnu de Cortex : rien n'est enregistré, rien ne casse", async () => {
  const r = await handleStripeEvent(ev("evt_k1", "charge.refunded", {
    id: "ch_k1", payment_intent: "pi_kairo", amount: 500, amount_refunded: 500, metadata: { app: "kairo" },
  }));
  assert.equal(r.ok, true);
  assert.equal((await revenue.accountRevenue("uk")).payments, 0);
  assert.equal((await revenue.totalRevenue()).payments > 0, true);
});

test("remboursement reçu AVANT l'achat : le paiement arrive déjà marqué remboursé", async () => {
  await handleStripeEvent(ev("evt_j1_r", "charge.refunded", {
    id: "ch_j1", payment_intent: "pi_j1", amount: 900, amount_refunded: 900, metadata: { cortexUserId: "uj", app: "cortex" },
  }));
  await handleStripeEvent(pack("j1", "uj"), { lookup: lookupWithFees({ pi_j1: 38 }) });
  near((await revenue.accountRevenue("uj")).netUsd, -38 * 1.1 / 100);
});
