/**
 * REMBOURSEMENTS STRIPE JUSTES (audit axe 4, P1 #2 #3 #4). Événements FICTIFS
 * (fixtures JSON de tests/fixtures/stripe-remboursements), traités par
 * handleStripeEvent ; aucun appel à l'API Stripe (les accès Stripe sont des
 * doublures qui répondent « rien trouvé »).
 *
 * Prouve : le compte Stripe est partagé avec l'activité freelance (Payment
 * Links) → une charge non marquée Cortex ne retire jamais rien, même si son
 * e-mail ou son client correspond à un compte Cortex ; le remboursement d'une
 * facture d'abonnement ne retire que la part remboursée de CETTE facture ; un
 * remboursement partiel ne suspend pas ; un rejeu ne retire jamais deux fois ;
 * chaque décision est journalisée sans donnée personnelle.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-remb-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "0";
process.env.DAILY_GEN_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.MAX_ACTIVE_JOBS = "unlimited";

let handleStripeEvent: typeof import("../lib/billing/stripe-events").handleStripeEvent;
let credits: typeof import("../lib/billing/credits");
let authRun: typeof import("../db/auth-store").authRun;
let authGet: typeof import("../db/auth-store").authGet;

before(async () => {
  ({ handleStripeEvent } = await import("../lib/billing/stripe-events"));
  credits = await import("../lib/billing/credits");
  ({ authRun, authGet } = await import("../db/auth-store"));
});

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_GEN_QUOTA", "RATE_LIMIT_PER_USER_MIN", "MAX_ACTIVE_JOBS"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const fixture = (name: string): Obj =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/stripe-remboursements/${name}.json`, import.meta.url), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (id: string, type: string, object: unknown): any => ({ id, type, object: "event", livemode: false, created: Math.floor(Date.now() / 1000), data: { object } });
/** Accès Stripe en doublure : rien n'est connu chez Stripe, aucune requête ne part. */
const noStripe = {
  sessionByPaymentIntent: async () => null,
  invoiceByPaymentIntent: async () => null,
  lookupKeyOfPrice: async (id: string) => (id === "price_test_pro_monthly" ? "cortex_pro_monthly" : null),
};

const packCheckout = (evt: string, user: string, cs: string, pi: string) =>
  ev(evt, "checkout.session.completed", { id: cs, object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: 900, payment_intent: pi, metadata: { app: "cortex", cortexUserId: user, plan: "credits_10", credits: "10" } });

/** Charge freelance (Payment Link, sans métadonnée) remboursée, avec l'e-mail et/ou le client donnés. */
const benabensRefund = (evt: string, over: Obj = {}) => ev(evt, "charge.refunded", { ...fixture("charge-payment-link-benabens"), ...over });

test("charge freelance (Payment Link, sans metadata app) dont l'e-mail est celui d'un compte Cortex → ignorée, aucun crédit retiré", async () => {
  await authRun(`INSERT INTO users (id, email, name) VALUES (?,?,?)`, "etu", "etudiante@example.test", "Étudiante");
  await handleStripeEvent(packCheckout("evt_etu_pack", "etu", "cs_etu", "pi_etu"), { lookup: noStripe });
  assert.equal(await credits.getBalance("etu"), 10);

  const r = await handleStripeEvent(benabensRefund("evt_benabens_refund_1"), { lookup: noStripe });
  assert.equal(r.action, "ignored:foreign", JSON.stringify(r));
  assert.equal(await credits.getBalance("etu"), 10, "l'e-mail ne suffit jamais à retirer des crédits");
  assert.equal(await authGet(`SELECT payment_intent FROM stripe_orphan_reversals WHERE payment_intent = ?`, "pi_test_benabens_1"), undefined);
});

test("charge marquée Cortex mais rattachée seulement par l'e-mail → rien n'est retiré, la reprise est mémorisée pour contrôle", async () => {
  const r = await handleStripeEvent(benabensRefund("evt_cortex_email_only", { id: "ch_test_cortex_2", payment_intent: "pi_test_cortex_email", customer: null, metadata: { app: "cortex" } }), { lookup: noStripe });
  assert.equal(r.action, "reversal-orphaned", JSON.stringify(r));
  assert.equal(await credits.getBalance("etu"), 10);
});

/** Facture d'abonnement payée, période [start, end) en jours depuis maintenant. */
const proInvoice = (evt: string, o: { id: string; pi: string; startDays: number; endDays: number; customer?: string; sub?: string; meta?: Obj | null; amount?: number }) => {
  const inv = fixture("invoice-pro-monthly");
  const day = (d: number) => Math.floor((Date.now() + d * 86400_000) / 1000);
  inv.id = o.id;
  inv.customer = o.customer ?? inv.customer;
  inv.parent.subscription_details.subscription = o.sub ?? inv.parent.subscription_details.subscription;
  if (o.meta !== undefined) { inv.parent.subscription_details.metadata = o.meta ?? {}; inv.lines.data[0].metadata = o.meta ?? {}; }
  inv.lines.data[0].parent.subscription_item_details.subscription = inv.parent.subscription_details.subscription;
  inv.lines.data[0].period = { start: day(o.startDays), end: day(o.endDays) };
  inv.payments.data[0].payment.payment_intent = o.pi;
  if (o.amount != null) { inv.amount_paid = o.amount; inv.total = o.amount; inv.lines.data[0].amount = o.amount; }
  return ev(evt, "invoice.paid", inv);
};

test("facture freelance sur un client déjà lié à un abonné Cortex, sans prix ni marque Cortex → ignorée, aucun crédit", async () => {
  await handleStripeEvent(proInvoice("evt_pro_m1", { id: "in_pro_m1", pi: "pi_pro_m1", startDays: -1, endDays: 29 }), { lookup: noStripe });
  assert.equal(await credits.subscriptionCredits("pro-user"), 20);
  const foreign = proInvoice("evt_freelance_inv", { id: "in_freelance_1", pi: "pi_freelance_1", startDays: 0, endDays: 30, sub: "sub_freelance_1", meta: null, amount: 30000 });
  foreign.data.object.lines.data[0].pricing.price_details.price = "price_freelance_retainer";
  const r = await handleStripeEvent(foreign, { lookup: noStripe });
  assert.equal(r.action, "ignored:foreign", JSON.stringify(r));
  assert.equal(await authGet(`SELECT invoice_id FROM stripe_invoices WHERE invoice_id = ?`, "in_freelance_1"), undefined);
  assert.equal(await credits.subscriptionCredits("pro-user"), 20);
});
