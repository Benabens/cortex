/**
 * ABONNEMENT ANNUEL ET FACTURES À 0 € (audit fuites I1, I2).
 *
 * I1 : l'annuel (149 €) ouvre une fenêtre de 20 crédits par mois. Un
 * remboursement total ou un litige doit reprendre TOUT ce que la facture a
 * accordé jusque-là (chaque fenêtre ouverte), pas un seul mois ; le reliquat
 * d'une fenêtre expirée l'absorbe avant toute dette.
 * I2 : une facture d'abonnement payée 0 € (code promo à 100 %) enregistre la
 * période mais n'accorde aucun crédit, ni à la facture ni aux fenêtres suivantes.
 *
 * Seam : handleStripeEvent (événements FICTIFS, aucune requête Stripe) + la
 * réservation (seul chemin de débit). Store auth SQLite jetable.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-annuel-"));
const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: tmp,
  BILLING_ENABLED: "1",
  SIGNUP_FREE_CREDITS: "0",
  DAILY_GEN_QUOTA: "unlimited",
  RATE_LIMIT_PER_USER_MIN: "unlimited",
  MAX_ACTIVE_JOBS: "unlimited",
};
Object.assign(process.env, ENV);

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
  for (const k of Object.keys(ENV)) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const fixture = (name: string): Obj =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/stripe-remboursements/${name}.json`, import.meta.url), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (id: string, type: string, object: unknown): any => ({ id, type, object: "event", livemode: false, created: Math.floor(Date.now() / 1000), data: { object } });
const noStripe = {
  sessionByPaymentIntent: async () => null,
  invoiceByPaymentIntent: async () => null,
  lookupKeyOfPrice: async (id: string) => (id === "price_test_pro_yearly" ? "cortex_pro_yearly" : id === "price_test_pro_monthly" ? "cortex_pro_monthly" : null),
};

/** Facture payée d'un abonné : annuel par défaut (149 €, période d'un an commencée il y a `startDays`). */
function invoice(evt: string, user: string, o: { startDays: number; endDays: number; amount?: number; plan?: "pro_yearly" | "pro_monthly" }) {
  const inv = fixture("invoice-pro-monthly");
  const plan = o.plan ?? "pro_yearly";
  const day = (d: number) => Math.floor((Date.now() + d * 86400_000) / 1000);
  const meta = { app: "cortex", cortexUserId: user, plan };
  inv.id = `in_${evt}`;
  inv.customer = `cus_${user}`;
  inv.parent.subscription_details.subscription = `sub_${user}`;
  inv.parent.subscription_details.metadata = meta;
  inv.lines.data[0].metadata = meta;
  inv.lines.data[0].parent.subscription_item_details.subscription = `sub_${user}`;
  inv.lines.data[0].pricing.price_details.price = `price_test_${plan}`;
  inv.lines.data[0].period = { start: day(o.startDays), end: day(o.endDays) };
  inv.payments.data[0].payment.payment_intent = `pi_${evt}`;
  const amount = o.amount ?? (plan === "pro_yearly" ? 14900 : 1490);
  inv.amount_paid = amount; inv.total = amount; inv.lines.data[0].amount = amount;
  return ev(evt, "invoice.paid", inv);
}
const refund = (evt: string, pi: string, refunded: number, amount = 14900) =>
  ev(evt, "charge.refunded", { ...fixture("charge-invoice-refunded"), id: `ch_${pi}`, payment_intent: pi, customer: null, amount, amount_refunded: refunded });

let n = 0;
async function spend(user: string, costCenti: number) {
  const reserve = await import("../lib/billing/reserve");
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const r = await runWithUser(user, () => runWithCourse("ml", () => reserve.reserveGeneration({ bucket: "gen", kind: "exam", costCenti, ref: `job:${user}:${++n}` })));
  assert.equal(r.ok, true, JSON.stringify(r));
}
/** Le temps passe sans horloge truquée : la période (et sa fenêtre ouverte) reculent de 40 jours, la fenêtre 2 est due. */
const nextMonth = (user: string) => {
  const d = new Date(Date.now() - 40 * 86400_000).toISOString().slice(0, 19).replace("T", " ");
  return authRun(`UPDATE subscriptions SET period_start = ?, window_anchor = ? WHERE user_id = ?`, d, d, user);
};

test("I1 : annuel, deux mois consommés puis remboursement total → les 40 crédits accordés sont repris, pas 20", async () => {
  await handleStripeEvent(invoice("yr_a", "annuel-a", { startDays: -1, endDays: 364 }), { lookup: noStripe });
  await spend("annuel-a", 2000);                                   // mois 1 : tout consommé
  await nextMonth("annuel-a");
  assert.equal(await credits.subscriptionCredits("annuel-a"), 20, "fenêtre 2 ouverte (recharge à la lecture)");
  await spend("annuel-a", 1500);                                   // mois 2 : 15 consommés, 5 restent
  const r = await handleStripeEvent(refund("yr_a_ref", "pi_yr_a", 14900), { lookup: noStripe });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await credits.subscriptionCredits("annuel-a"), 0, "remboursement total : abonnement suspendu");
  assert.equal(await credits.getBalance("annuel-a"), -35, "40 accordés − 5 encore au solde = 35 consommés en dette");
});

test("I1 : le reliquat d'une fenêtre expirée absorbe la reprise avant toute dette (fenêtre ouverte par la réservation)", async () => {
  await handleStripeEvent(invoice("yr_b", "annuel-b", { startDays: -1, endDays: 364 }), { lookup: noStripe });
  await spend("annuel-b", 500);                                    // mois 1 : 15 expirent sans servir
  await nextMonth("annuel-b");
  await spend("annuel-b", 2000);                                   // ouvre la fenêtre 2 et la consomme
  const inv = await authGet<{ granted_centi: number; unused_centi: number | null }>(
    `SELECT granted_centi, unused_centi FROM stripe_invoices WHERE invoice_id = ?`, "in_yr_b",
  );
  assert.deepEqual([Number(inv?.granted_centi), Number(inv?.unused_centi)], [4000, 1500], "accordé et reliquat expiré suivis sur la facture");
  await handleStripeEvent(ev("yr_b_dsp", "charge.dispute.created", { id: "dp_yr_b", object: "dispute", payment_intent: "pi_yr_b", amount: 14900 }), { lookup: noStripe });
  assert.equal(await credits.getBalance("annuel-b"), -25, "40 accordés − 15 expirés = 25 consommés en dette");
});

test("I1 : une fenêtre ne s'ajoute qu'une fois à la facture, même relue de partout", async () => {
  await handleStripeEvent(invoice("yr_c", "annuel-c", { startDays: -1, endDays: 364 }), { lookup: noStripe });
  await nextMonth("annuel-c");
  for (let i = 0; i < 3; i++) await credits.subscriptionCredits("annuel-c");
  await spend("annuel-c", 100);
  const inv = await authGet<{ granted_centi: number }>(`SELECT granted_centi FROM stripe_invoices WHERE invoice_id = ?`, "in_yr_c");
  assert.equal(Number(inv?.granted_centi), 4000);
});

test("I2 : facture d'abonnement payée 0 € → période enregistrée, aucun crédit, ni maintenant ni à la fenêtre suivante", async () => {
  await handleStripeEvent(invoice("yr_free", "gratuit", { startDays: -1, endDays: 364, amount: 0 }), { lookup: noStripe });
  assert.equal(await credits.subscriptionCredits("gratuit"), 0, "aucun crédit à 0 €");
  await nextMonth("gratuit");
  assert.equal(await credits.subscriptionCredits("gratuit"), 0);
  const inv = await authGet<{ granted_centi: number }>(`SELECT granted_centi FROM stripe_invoices WHERE invoice_id = ?`, "in_yr_free");
  assert.equal(Number(inv?.granted_centi), 0, "la facture n'a rien accordé");
  // Une facture payée ensuite rend les crédits.
  await handleStripeEvent(invoice("m_paid", "gratuit", { startDays: 0, endDays: 30, plan: "pro_monthly" }), { lookup: noStripe });
  assert.equal(await credits.subscriptionCredits("gratuit"), 20);
});
