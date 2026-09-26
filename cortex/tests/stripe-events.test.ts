/**
 * STRIPE — attribution et reprise des crédits par le webhook (c'est de l'argent).
 * Charges d'événements SIMULÉES, traitées par handleStripeEvent (sans signature —
 * la route vérifie la signature et le livemode avant d'appeler).
 *
 * Prouve : pack → +10 ; abonnement → +20 ; renouvellement → +20 et reliquat du
 * mois précédent PERDU (non reportable) ; résiliation → plus rien après la
 * période ; rejeu (même event.id, OU autre event.id pour la même session /
 * facture) → AUCUNE double attribution ; remboursement / litige d'un pack ou
 * d'une facture d'abonnement → crédits repris, une seule fois.
 *
 * Store auth SQLite dans un dossier jetable (CORTEX_DATA_DIR). Unités
 * internes en centièmes ; les assertions lisent en crédits.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-stripe-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "0"; // isole les montants testés du palier gratuit
process.env.DAILY_GEN_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.MAX_ACTIVE_JOBS = "unlimited";

let handleStripeEvent: typeof import("../lib/billing/stripe-events").handleStripeEvent;
let reserve: typeof import("../lib/billing/reserve");
let credits: typeof import("../lib/billing/credits");

before(async () => {
  ({ handleStripeEvent } = await import("../lib/billing/stripe-events"));
  reserve = await import("../lib/billing/reserve");
  credits = await import("../lib/billing/credits");
});

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_GEN_QUOTA", "RATE_LIMIT_PER_USER_MIN", "MAX_ACTIVE_JOBS"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (id: string, type: string, object: unknown): any => ({ id, type, data: { object } });
const futureUnix = (days: number) => Math.floor((Date.now() + days * 86400_000) / 1000);

const checkoutPack = (id: string, user: string, sessionId = `cs_${id}`, pi = `pi_${sessionId}`) =>
  ev(id, "checkout.session.completed", { id: sessionId, mode: "payment", payment_status: "paid", payment_intent: pi, metadata: { cortexUserId: user, plan: "credits_10", credits: "10" } });
const checkoutSub = (id: string, user: string, customer: string, sub: string) =>
  ev(id, "checkout.session.completed", { mode: "subscription", customer, subscription: sub, metadata: { cortexUserId: user, plan: "pro_monthly" } });
const invoicePaid = (id: string, customer: string, sub: string, periodEndDays: number, invoiceId = `in_${id}`, pi = `pi_${invoiceId}`) =>
  ev(id, "invoice.paid", { id: invoiceId, customer, subscription: sub, payment_intent: pi, lines: { data: [{ period: { end: futureUnix(periodEndDays) }, price: { lookup_key: "cortex_pro_monthly" } }] } });
/** Débit par la réservation atomique (le seul chemin de débit), en centièmes. */
async function spend(user: string, costCenti: number, ref: string) {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const r = await runWithUser(user, () => runWithCourse("ml", () => reserve.reserveGeneration({ bucket: "gen", kind: "exam", costCenti, ref })));
  assert.equal(r.ok, true, JSON.stringify(r));
}
const subDeleted = (id: string, customer: string, sub: string) =>
  ev(id, "customer.subscription.deleted", { id: sub, customer, status: "canceled" });

test("pack → +10 crédits (permanents)", async () => {
  await handleStripeEvent(checkoutPack("evt_pack_1", "buyer"));
  assert.equal(await credits.getBalance("buyer"), 10);
});

test("rejeu du même événement pack → PAS de double attribution", async () => {
  await handleStripeEvent(checkoutPack("evt_pack_1", "buyer")); // même id
  assert.equal(await credits.getBalance("buyer"), 10, "toujours 10, pas 20");
});

test("abonnement : checkout (lien) + invoice.paid → +20 crédits du mois", async () => {
  await handleStripeEvent(checkoutSub("evt_co_1", "pro", "cus_pro", "sub_pro"));
  assert.equal(await credits.subscriptionCredits("pro"), 0, "checkout seul n'attribue rien");
  await handleStripeEvent(invoicePaid("evt_inv_1", "cus_pro", "sub_pro", 30));
  assert.equal(await credits.subscriptionCredits("pro"), 20);
  assert.equal(await credits.getBalance("pro"), 20);
});

test("renouvellement → +20 et le reliquat du mois précédent est PERDU (non reportable)", async () => {
  // consomme 5 des 20 → reste 15
  await spend("pro", 500, "job:pro:x:1");
  assert.equal(await credits.subscriptionCredits("pro"), 15);
  // renouvellement (nouvelle facture, période suivante) → remise à 20, pas 35
  await handleStripeEvent(invoicePaid("evt_inv_2", "cus_pro", "sub_pro", 60));
  assert.equal(await credits.subscriptionCredits("pro"), 20, "reliquat de 15 perdu, remis à 20");
});

test("rejeu du même invoice → pas de re-remise à 20", async () => {
  await spend("pro", 800, "job:pro:x:2"); // reste 12
  assert.equal(await credits.subscriptionCredits("pro"), 12);
  await handleStripeEvent(invoicePaid("evt_inv_2", "cus_pro", "sub_pro", 60)); // MÊME id
  assert.equal(await credits.subscriptionCredits("pro"), 12, "événement déjà traité → inchangé");
});

test("débit sub-first : l'abonnement est consommé avant les crédits achetés", async () => {
  // 'pro' a 12 crédits d'abo ; on lui ajoute 10 achetés, puis on dépense 15
  await credits.addTransaction("pro", 1000, "achat credits_10", "buy:pro:1");
  assert.equal(await credits.getBalance("pro"), 22); // 12 abo + 10 achetés
  await spend("pro", 1500, "job:pro:x:3");
  assert.equal(await credits.subscriptionCredits("pro"), 0, "12 d'abo consommés d'abord");
  assert.equal(await credits.getBalance("pro"), 7, "reste 7 achetés (22-15)");
});

test("annuel : 20 crédits/mois se renouvellent chaque MOIS (recharge paresseuse), sans nouvelle facture", async () => {
  const { authRun } = await import("../db/auth-store");
  await handleStripeEvent(checkoutSub("evt_co_y", "yearly", "cus_y", "sub_y"));
  // une seule facture annuelle, période 1 an
  await handleStripeEvent(ev("evt_inv_y", "invoice.paid", {
    customer: "cus_y", subscription: "sub_y",
    lines: { data: [{ period: { end: futureUnix(365) }, price: { lookup_key: "cortex_pro_yearly" } }] },
  }));
  assert.equal(await credits.subscriptionCredits("yearly"), 20);
  await spend("yearly", 1200, "job:yearly:1"); // reste 8
  assert.equal(await credits.subscriptionCredits("yearly"), 8);
  // passage au mois suivant simulé (month_anchor dans le passé), période encore valide
  await authRun(`UPDATE subscriptions SET month_anchor = ? WHERE user_id = ?`, "2000-01", "yearly");
  assert.equal(await credits.subscriptionCredits("yearly"), 20, "nouveau mois → recharge à 20 sans nouvelle facture");
});

test("résiliation (subscription.deleted) → crédits du mois à 0, plus d'attribution", async () => {
  await handleStripeEvent(invoicePaid("evt_inv_3", "cus_pro", "sub_pro", 90)); // remet 20
  assert.equal(await credits.subscriptionCredits("pro"), 20);
  await handleStripeEvent(subDeleted("evt_del_1", "cus_pro", "sub_pro"));
  assert.equal(await credits.subscriptionCredits("pro"), 0, "fin d'abonnement → 0");
  // les crédits ACHETÉS survivent
  assert.equal(await credits.getBalance("pro"), 7);
});

test("rejeu sous un AUTRE event.id : même session de pack → pas de double crédit ; même facture → pas de re-remise", async () => {
  await handleStripeEvent(checkoutPack("evt_pack_1bis", "buyer", "cs_evt_pack_1")); // même session, autre id
  assert.equal(await credits.getBalance("buyer"), 10);
  await handleStripeEvent(checkoutSub("evt_co_2", "dup", "cus_dup", "sub_dup"));
  await handleStripeEvent(invoicePaid("evt_inv_d1", "cus_dup", "sub_dup", 30, "in_dup_1"));
  await spend("dup", 500, "job:dup:1"); // reste 15
  await handleStripeEvent(invoicePaid("evt_inv_d1bis", "cus_dup", "sub_dup", 30, "in_dup_1")); // même facture, autre event
  assert.equal(await credits.subscriptionCredits("dup"), 15, "une facture n'attribue qu'une fois");
});

test("remboursement d'un pack → les 10 crédits sont repris (solde négatif possible), une seule fois même après litige", async () => {
  await spend("buyer", 400, "job:buyer:1"); // 10 → 6 achetés
  const r = await handleStripeEvent(ev("evt_ref_p", "charge.refunded", { id: "ch_p", object: "charge", payment_intent: "pi_cs_evt_pack_1", amount: 900, amount_refunded: 900 }));
  assert.equal(r.ok, true);
  assert.equal(await credits.getBalance("buyer"), -4, "6 − 10 : le compte est bloqué jusqu'au prochain achat");
  await handleStripeEvent(ev("evt_dsp_p", "charge.dispute.created", { id: "dp_p", object: "dispute", payment_intent: "pi_cs_evt_pack_1", amount: 900 }));
  assert.equal(await credits.getBalance("buyer"), -4, "litige sur un achat déjà repris : pas de seconde reprise");
});

test("remboursement d'une facture d'abonnement : les 20 du mois sont retirés s'ils sont encore là", async () => {
  await handleStripeEvent(checkoutSub("evt_co_3", "refunded", "cus_rf", "sub_rf"));
  await handleStripeEvent(invoicePaid("evt_inv_rf", "cus_rf", "sub_rf", 30, "in_rf", "pi_in_rf"));
  assert.equal(await credits.subscriptionCredits("refunded"), 20);
  const r = await handleStripeEvent(ev("evt_ref_rf", "charge.refunded", { id: "ch_rf", object: "charge", payment_intent: "pi_in_rf", amount: 1490, amount_refunded: 1490 }));
  assert.equal(r.ok, true);
  assert.equal(await credits.subscriptionCredits("refunded"), 0, "les 20 du mois repris");
  assert.equal(await credits.getBalance("refunded"), 0);
});

test("remboursement d'une facture déjà en partie consommée : le reste est repris et le manque bloque le compte", async () => {
  await handleStripeEvent(checkoutSub("evt_co_4", "spent", "cus_sp", "sub_sp"));
  await handleStripeEvent(invoicePaid("evt_inv_sp", "cus_sp", "sub_sp", 30, "in_sp", "pi_in_sp"));
  await spend("spent", 1500, "job:spent:1"); // 20 → 5 restants
  await handleStripeEvent(ev("evt_ref_sp", "charge.refunded", { id: "ch_sp", object: "charge", payment_intent: "pi_in_sp", amount: 1490, amount_refunded: 1490 }));
  assert.equal(await credits.subscriptionCredits("spent"), 0, "les 5 restants repris");
  assert.equal(await credits.getBalance("spent"), -15, "les 15 consommés passent en dette : plus aucune génération");
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const g = await runWithUser("spent", () => runWithCourse("ml", () => reserve.reserveGeneration({ bucket: "assist", kind: "assist", costCenti: 10, ref: "assist:spent:1" })));
  assert.equal(g.ok, false);
  // rejeu du même remboursement → rien de plus
  await handleStripeEvent(ev("evt_ref_sp2", "charge.refunded", { id: "ch_sp", object: "charge", payment_intent: "pi_in_sp", amount: 1490, amount_refunded: 1490 }));
  assert.equal(await credits.getBalance("spent"), -15);
});

// ── Lot 2b-3/4/6 : achats inconnus, atomicité, ordre des événements ──────────

test("2b-6 : session gratuite (no_payment_required / montant 0) → AUCUN crédit", async () => {
  const free = ev("evt_free_1", "checkout.session.completed", { id: "cs_free_1", mode: "payment", payment_status: "no_payment_required", amount_total: 0, payment_intent: null, metadata: { cortexUserId: "free", plan: "credits_10", credits: "10" } });
  const r = await handleStripeEvent(free);
  assert.equal(r.credited, false);
  assert.equal(await credits.getBalance("free"), 0);
  const zero = ev("evt_free_2", "checkout.session.completed", { id: "cs_free_2", mode: "payment", payment_status: "paid", amount_total: 0, payment_intent: "pi_free_2", metadata: { cortexUserId: "free", plan: "credits_10", credits: "10" } });
  assert.equal((await handleStripeEvent(zero)).credited, false);
  assert.equal(await credits.getBalance("free"), 0);
});

test("2b-6 : remboursement reçu AVANT l'achat → reprise mémorisée puis appliquée quand l'achat arrive (solde net 0)", async () => {
  const { authGet } = await import("../db/auth-store");
  const early = await handleStripeEvent(ev("evt_early_refund", "charge.refunded", { payment_intent: "pi_cs_early", amount: 900, amount_refunded: 900 }));
  assert.equal(early.ok, true);
  assert.equal(early.action, "reversal-orphaned");
  assert.ok(await authGet(`SELECT payment_intent FROM stripe_orphan_reversals WHERE payment_intent = ?`, "pi_cs_early"), "reprise mémorisée");
  const r = await handleStripeEvent(checkoutPack("evt_late_purchase", "erin", "cs_early", "pi_cs_early"));
  assert.equal(r.credited, true);
  assert.equal(r.reversed, true);
  assert.equal(await credits.getBalance("erin"), 0, "crédité puis repris : net 0");
  assert.equal(await authGet(`SELECT payment_intent FROM stripe_orphan_reversals WHERE payment_intent = ?`, "pi_cs_early"), undefined);
  // Le même remboursement rejoué ne reprend pas deux fois.
  assert.equal((await handleStripeEvent(ev("evt_early_refund_bis", "charge.refunded", { payment_intent: "pi_cs_early", amount: 900, amount_refunded: 900 }))).reversed, false);
  assert.equal(await credits.getBalance("erin"), 0);
});

test("2b-3 : achat absent de stripe_purchases → retrouvé par l'API Stripe (session ↔ payment_intent), repris et enregistré", async () => {
  const { authGet } = await import("../db/auth-store");
  await credits.addTransaction("frank", 1000, "achat crédité par l'ancien code", "evt_old_style_frank");
  const asked: string[] = [];
  const lookup = { sessionByPaymentIntent: async (pi: string) => { asked.push(pi); return pi === "pi_frank_old" ? { id: "cs_frank_old", userId: "frank", credits: 10 } : null; } };
  const r = await handleStripeEvent(ev("evt_refund_frank", "charge.refunded", { payment_intent: "pi_frank_old", amount: 900, amount_refunded: 900 }), { lookup });
  assert.deepEqual(asked, ["pi_frank_old"]);
  assert.equal(r.action, "pack-reversed");
  assert.equal(await credits.getBalance("frank"), 0);
  assert.ok(await authGet(`SELECT session_id FROM stripe_purchases WHERE payment_intent = ?`, "pi_frank_old"), "achat désormais connu");
});

test("2b-3 : sinon, métadonnées de la charge (payment_intent_data) + montant → crédits repris au prix du pack", async () => {
  await credits.addTransaction("gina", 1000, "achat crédité par l'ancien code", "evt_old_style_gina");
  const r = await handleStripeEvent(ev("evt_refund_gina", "charge.refunded", { payment_intent: "pi_gina", amount: 900, amount_refunded: 450, metadata: { cortexUserId: "gina", plan: "credits_10", credits: "10" } }));
  assert.equal(r.action, "pack-reversed-by-amount");
  assert.equal(await credits.getBalance("gina"), 5, "450 centimes remboursés = 5 crédits (9 € les 10)");
});

test("2b-3 : client Stripe connu (abonné) sans achat retrouvé → montant converti en crédits", async () => {
  await handleStripeEvent(checkoutSub("evt_sub_h", "hugo", "cus_hugo", "sub_hugo"));
  await credits.addTransaction("hugo", 1000, "achat crédité par l'ancien code", "evt_old_style_hugo");
  const r = await handleStripeEvent(ev("evt_refund_hugo", "charge.refunded", { payment_intent: "pi_hugo_pack", customer: "cus_hugo", amount: 900, amount_refunded: 900 }));
  assert.equal(r.action, "pack-reversed-by-amount");
  assert.equal(await credits.getBalance("hugo"), 0);
});

test("2b-3 : rien d'exploitable → jamais silencieux : mémorisé, signalé en erreur, résultat explicite", async () => {
  const { authGet } = await import("../db/auth-store");
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  try {
    const r = await handleStripeEvent(ev("evt_refund_ghost", "charge.refunded", { payment_intent: "pi_ghost", amount: 900, amount_refunded: 900 }));
    assert.equal(r.action, "reversal-orphaned");
    assert.match(r.error ?? "", /inconnu/);
    assert.ok(errors.some((l) => /reversal_unresolved/.test(l) && /pi_ghost/.test(l)), `journal d'erreur attendu, reçu : ${errors.join(" | ")}`);
  } finally { console.error = orig; }
  assert.ok(await authGet(`SELECT payment_intent FROM stripe_orphan_reversals WHERE payment_intent = ?`, "pi_ghost"));
});

test("2b-4 : l'enregistrement de l'achat échoue → rien n'est crédité, l'événement lève (Stripe rejoue), puis passe", async () => {
  const { authRun } = await import("../db/auth-store");
  await authRun(`ALTER TABLE stripe_purchases RENAME TO stripe_purchases_off`);
  try {
    await assert.rejects(handleStripeEvent(checkoutPack("evt_atomic_1", "ivan", "cs_ivan", "pi_ivan")));
  } finally {
    await authRun(`ALTER TABLE stripe_purchases_off RENAME TO stripe_purchases`);
  }
  assert.equal(await credits.getBalance("ivan"), 0, "crédit et enregistrement vont ensemble ou pas du tout");
  const r = await handleStripeEvent(checkoutPack("evt_atomic_1", "ivan", "cs_ivan", "pi_ivan"));
  assert.equal(r.credited, true);
  assert.equal(await credits.getBalance("ivan"), 10);
});

test("revue : reprise orpheline PARTIELLE (4,50 € avant l'achat) → 5 crédits repris, pas 10", async () => {
  const early = await handleStripeEvent(ev("evt_early_partial", "charge.refunded", { payment_intent: "pi_cs_partial", amount: 900, amount_refunded: 450 }));
  assert.equal(early.action, "reversal-orphaned");
  const r = await handleStripeEvent(checkoutPack("evt_late_partial", "jade", "cs_partial", "pi_cs_partial"));
  assert.equal(r.reversed, true);
  assert.equal(await credits.getBalance("jade"), 5, "10 crédités, 5 repris (450 centimes au prix du pack)");
});

test("lot 4-6 : remboursement PARTIEL d'un pack connu → prorata arrondi au crédit supérieur, cumulatif, puis litige sans double reprise", async () => {
  await handleStripeEvent(checkoutPack("evt_kim_buy", "kim", "cs_kim", "pi_kim"));
  assert.equal(await credits.getBalance("kim"), 10);
  await handleStripeEvent(ev("evt_kim_r1", "charge.refunded", { payment_intent: "pi_kim", amount: 900, amount_refunded: 300 }));
  assert.equal(await credits.getBalance("kim"), 6, "300/900 × 10 = 3,33 → 4 crédits repris");
  await handleStripeEvent(ev("evt_kim_r2", "charge.refunded", { payment_intent: "pi_kim", amount: 900, amount_refunded: 450 }));
  assert.equal(await credits.getBalance("kim"), 5, "cumul 450/900 → 5 repris au total, donc 1 de plus");
  const again = await handleStripeEvent(ev("evt_kim_r2bis", "charge.refunded", { payment_intent: "pi_kim", amount: 900, amount_refunded: 450 }));
  assert.equal(again.reversed, false, "même cumul rejoué → rien");
  await handleStripeEvent(ev("evt_kim_r3", "charge.refunded", { payment_intent: "pi_kim", amount: 900, amount_refunded: 900 }));
  assert.equal(await credits.getBalance("kim"), 0);
  const dispute = await handleStripeEvent(ev("evt_kim_d", "charge.dispute.created", { payment_intent: "pi_kim", amount: 900 }));
  assert.equal(dispute.reversed, false);
  assert.equal(await credits.getBalance("kim"), 0);
});
