/**
 * REPRISE DE L'HISTORIQUE STRIPE (npm run billing:backfill) : les paiements
 * antérieurs à l'enregistrement du revenu (stripe_purchases, stripe_invoices)
 * sont relus chez Stripe et enregistrés avec leurs frais réels, remboursements
 * et litiges — le budget IA d'un compte qui a déjà payé ne part pas de zéro.
 *
 * Prouve : dry-run → rien n'est écrit, le rapport annonce ce qui le serait ;
 * --write → revenu net exact (frais réels, remboursement, litige et ses frais) ;
 * rejeu → rien en double ; frais estimés remplacés par les frais réels ;
 * paiement introuvable ou erreur Stripe → écarté avec sa raison, les autres passent.
 *
 * Seams : revenue-backfill.backfillRevenue({ read, api, write }) et
 * revenue.accountRevenue(userId). PGlite en mémoire, Stripe simulé (aucun réseau).
 */
import assert from "node:assert/strict";
import { before, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.BILLING_ENABLED = "1";
process.env.FX_USD_JSON = JSON.stringify({ eur: 1 });
process.env.STRIPE_FEE_PERCENT = "3.25";
process.env.STRIPE_FEE_FIXED_CENTS = "25";
process.env.STRIPE_DISPUTE_FEE_CENTS = "2000";

type Api = import("../lib/billing/revenue-backfill").BackfillStripe;
let backfillRevenue: typeof import("../lib/billing/revenue-backfill").backfillRevenue;
let revenue: typeof import("../lib/billing/revenue");
let read: (sql: string, ...p: Array<string | number | null>) => Promise<Record<string, unknown>[]>;
let paidAt = "";

const api: Api = {
  async checkoutSession(id) {
    if (id === "cs_boom") throw new Error("boom réseau");
    if (id === "cs_old") return { amountCents: 900, currency: "eur", taxCents: 0, paymentIntent: "pi_old", paidAt, livemode: true };
    if (id === "cs_new") return { amountCents: 900, currency: "eur", taxCents: 0, paymentIntent: "pi_new", paidAt, livemode: true };
    return null; // session non payée ou inconnue
  },
  async invoice(id) {
    if (id === "in_old") return { amountCents: 1490, currency: "eur", taxCents: 0, paymentIntent: "pi_inv", paidAt, livemode: true };
    return null;
  },
  async payment(pi) {
    if (pi === "pi_old") return { feeCents: 46, refundedCents: 300, disputes: [] };
    if (pi === "pi_inv") return { feeCents: 74, refundedCents: 0, disputes: [{ amountCents: 500, feeCents: 1500 }] };
    if (pi === "pi_new") return { feeCents: 46, refundedCents: 0, disputes: [] };
    return null;
  },
};

before(async () => {
  ({ backfillRevenue } = await import("../lib/billing/revenue-backfill"));
  revenue = await import("../lib/billing/revenue");
  const { authAll, authRun } = await import("../db/auth-store");
  read = (sql, ...p) => authAll(sql, ...p);
  paidAt = revenue.sinceDays(30);
  for (const [sid, pi, user] of [["cs_old", "pi_old", "ana"], ["cs_unpaid", null, "bob"], ["cs_boom", "pi_boom", "bob"], ["cs_new", "pi_new", "cleo"]]) {
    await authRun(`INSERT INTO stripe_purchases (session_id, payment_intent, user_id, credits_centi, livemode, created_at) VALUES (?,?,?,?,?,?)`,
      sid, pi, user!, 1000, 1, paidAt);
  }
  await authRun(`INSERT INTO stripe_invoices (invoice_id, subscription_id, customer_id, payment_intent, user_id, granted_centi, period_end, created_at)
    VALUES (?,?,?,?,?,?,?,?)`, "in_old", "sub_1", "cus_1", null, "ana", 2000, null, paidAt);
  // Payé après le déploiement, quand Stripe ne répondait pas : frais estimés (ceil(3,25 % × 900) + 25 = 55).
  await revenue.recordPayment({ sourceId: "cs_new", kind: "pack", paymentIntent: "pi_new", userId: "cleo", currency: "eur", amountCents: 900, feeCents: null, paidAt });
});

test("dry-run : rien n'est écrit, le rapport annonce les paiements à reprendre, frais à corriger et pertes", async () => {
  const r = await backfillRevenue({ read, api, write: false });
  assert.equal(r.toRecord, 2, "le pack et la facture antérieurs");
  assert.equal(Math.round(r.recordedGrossUsd * 100), 2390);
  assert.equal(r.feesToFix, 1);
  assert.equal(r.refunds, 1);
  assert.equal(r.disputes, 1);
  assert.deepEqual(r.skipped.map((s) => s.sourceId).sort(), ["cs_boom", "cs_unpaid"]);
  assert.match(r.skipped.find((s) => s.sourceId === "cs_boom")!.why, /boom/);
  assert.equal((await revenue.accountRevenue("ana")).payments, 0, "dry-run : aucun paiement enregistré");
  assert.equal(Math.round((await revenue.accountRevenue("cleo")).netUsd * 100), 845, "dry-run : frais toujours estimés");
});

test("--write : revenu net exact ; rejeu sans double compte", async () => {
  await backfillRevenue({ read, api, write: true });
  // ana : pack 900 − 300 remboursés − 46 de frais = 554 ; facture 1490 − 500 contestés − 74 − 1500 de frais de litige
  // − 11 de frais Stripe Billing (0,7 %) = −595.
  const ana = await revenue.accountRevenue("ana");
  assert.equal(ana.payments, 2);
  assert.equal(Math.round(ana.netUsd * 100), -41);
  assert.equal(ana.estimatedFees, 0, "frais réels partout");
  // cleo : frais réels (46) au lieu de l'estimation (55).
  assert.equal(Math.round((await revenue.accountRevenue("cleo")).netUsd * 100), 854);
  const again = await backfillRevenue({ read, api, write: true });
  assert.equal(again.toRecord, 0);
  assert.equal(again.feesToFix, 0);
  assert.equal(Math.round((await revenue.accountRevenue("ana")).netUsd * 100), -41, "remboursement et litige non additionnés deux fois");
});
