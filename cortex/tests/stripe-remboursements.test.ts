// Mécanique écrite avec le Pro à 20 crédits/mois (défaut avant le 25/11/2026, 30 depuis) : figé ici.
process.env.SUBSCRIPTION_MONTHLY_CREDITS = "20";
/**
 * REMBOURSEMENTS STRIPE JUSTES. Événements FICTIFS
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
// Route du webhook : clé et secret FICTIFS, jamais envoyés nulle part (signature calculée localement).
process.env.STRIPE_SECRET_KEY = "sk_test_fictive_local_only";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fictive_local";

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
  for (const k of ["CORTEX_DATA_DIR", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_GEN_QUOTA", "RATE_LIMIT_PER_USER_MIN", "MAX_ACTIVE_JOBS", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) delete process.env[k];
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

/** Débit par la réservation atomique (le seul chemin de débit), en centièmes. */
async function spend(user: string, costCenti: number, ref: string) {
  const reserve = await import("../lib/billing/reserve");
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const r = await runWithUser(user, () => runWithCourse("ml", () => reserve.reserveGeneration({ bucket: "gen", kind: "exam", costCenti, ref })));
  assert.equal(r.ok, true, JSON.stringify(r));
}
const suspended = async (user: string) => Number((await credits.getSubscription(user))?.suspended ?? 0) === 1;
/** Charge d'une facture d'abonnement remboursée (cumul `refunded` sur `amount`). */
const invoiceRefund = (evt: string, pi: string, refunded: number, amount = 1490) =>
  ev(evt, "charge.refunded", { ...fixture("charge-invoice-refunded"), id: `ch_${pi}`, payment_intent: pi, customer: null, amount, amount_refunded: refunded });
/** Abonné avec deux mois payés : le mois 1 (déjà consommé de `spentInM1`), puis le mois 2 en cours. */
async function twoMonths(user: string, spentInM1: number) {
  const o = { customer: `cus_${user}`, sub: `sub_${user}`, meta: { app: "cortex", cortexUserId: user, plan: "pro_monthly" } };
  await handleStripeEvent(proInvoice(`evt_${user}_m1`, { ...o, id: `in_${user}_m1`, pi: `pi_${user}_m1`, startDays: -1, endDays: 29 }), { lookup: noStripe });
  if (spentInM1) await spend(user, spentInM1, `job:${user}:m1`);
  await handleStripeEvent(proInvoice(`evt_${user}_m2`, { ...o, id: `in_${user}_m2`, pi: `pi_${user}_m2`, startDays: 0, endDays: 30 }), { lookup: noStripe });
  assert.equal(await credits.subscriptionCredits(user), 20, "mois 2 : 20 crédits");
}

test("rembourser l'ANCIENNE facture (crédits inutilisés, expirés) → mois en cours intact, rien en dette, pas de suspension", async () => {
  await twoMonths("ancien", 0);
  const r = await handleStripeEvent(invoiceRefund("evt_ancien_ref", "pi_ancien_m1", 1490), { lookup: noStripe });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await credits.subscriptionCredits("ancien"), 20, "les crédits du mois 2, payé, restent");
  assert.equal(await credits.getBalance("ancien"), 20, "les 20 du mois 1 avaient expiré sans servir : aucune dette");
  assert.equal(await suspended("ancien"), false);
});

test("rembourser l'ANCIENNE facture déjà consommée de 15 → seuls les 15 consommés passent en dette, mois en cours intact", async () => {
  await twoMonths("ancien2", 1500);
  await handleStripeEvent(invoiceRefund("evt_ancien2_ref", "pi_ancien2_m1", 1490), { lookup: noStripe });
  assert.equal(await credits.subscriptionCredits("ancien2"), 20);
  assert.equal(await credits.getBalance("ancien2"), 5, "20 du mois 2 − 15 consommés au mois 1 remboursé");
  assert.equal(await suspended("ancien2"), false);
});

/** Abonné avec la facture du mois en cours payée (20 crédits). */
async function oneMonth(user: string) {
  await handleStripeEvent(proInvoice(`evt_${user}_m1`, { id: `in_${user}_m1`, pi: `pi_${user}_m1`, customer: `cus_${user}`, sub: `sub_${user}`, meta: { app: "cortex", cortexUserId: user, plan: "pro_monthly" }, startDays: -1, endDays: 29 }), { lookup: noStripe });
  assert.equal(await credits.subscriptionCredits(user), 20);
}

test("geste commercial de 1 € sur 14,90 € (facture en cours) → 1,35 crédit retiré (prorata), pas de suspension", async () => {
  await oneMonth("geste");
  const r = await handleStripeEvent(invoiceRefund("evt_geste_ref", "pi_geste_m1", 100), { lookup: noStripe });
  assert.equal(r.action, "invoice-reversed", JSON.stringify(r));
  assert.equal(await credits.subscriptionCredits("geste"), 18.65, "20 × 100/1490 = 1,342 → 1,35 retiré (au centième supérieur)");
  assert.equal(await credits.getBalance("geste"), 18.65, "rien en dette : le mois en couvrait la part");
  assert.equal(await suspended("geste"), false, "un remboursement partiel ne suspend pas");
});

test("remboursements partiels successifs (cumul Stripe) puis rejeu et nouvel événement au même cumul → jamais deux fois", async () => {
  await oneMonth("cumul");
  await handleStripeEvent(invoiceRefund("evt_cumul_1", "pi_cumul_m1", 745), { lookup: noStripe }); // moitié
  assert.equal(await credits.subscriptionCredits("cumul"), 10);
  const replay = await handleStripeEvent(invoiceRefund("evt_cumul_1", "pi_cumul_m1", 745), { lookup: noStripe }); // même event.id
  assert.equal(replay.action, "duplicate");
  const sameTotal = await handleStripeEvent(invoiceRefund("evt_cumul_1bis", "pi_cumul_m1", 745), { lookup: noStripe }); // autre id, même cumul
  assert.equal(sameTotal.reversed, false);
  assert.equal(await credits.subscriptionCredits("cumul"), 10, "toujours 10");
  assert.equal(await suspended("cumul"), false);
  // Le reste remboursé : le cumul atteint la facture entière → le reste est repris et l'abonnement suspendu.
  const rest = await handleStripeEvent(invoiceRefund("evt_cumul_2", "pi_cumul_m1", 1490), { lookup: noStripe });
  assert.equal(rest.reversed, true);
  assert.equal(await credits.getBalance("cumul"), 0);
  assert.equal(await suspended("cumul"), true, "remboursement TOTAL de la facture en cours → suspendu");
  // Litige ensuite sur le même paiement : rien de plus.
  const dispute = await handleStripeEvent(ev("evt_cumul_d", "charge.dispute.created", { id: "dp_cumul", object: "dispute", payment_intent: "pi_cumul_m1", amount: 1490 }), { lookup: noStripe });
  assert.equal(dispute.reversed, false);
  assert.equal(await credits.getBalance("cumul"), 0);
});

test("remboursement partiel d'une ANCIENNE facture consommée : prorata, absorbé par le reliquat expiré puis en dette, jamais deux fois", async () => {
  await twoMonths("ancien3", 1500); // mois 1 : 15 consommés, 5 expirés inutilisés
  await handleStripeEvent(invoiceRefund("evt_ancien3_r1", "pi_ancien3_m1", 745), { lookup: noStripe }); // moitié → 10 à reprendre
  assert.equal(await credits.getBalance("ancien3"), 15, "10 repris : 5 du reliquat expiré, 5 en dette");
  await handleStripeEvent(invoiceRefund("evt_ancien3_r1bis", "pi_ancien3_m1", 745), { lookup: noStripe });
  assert.equal(await credits.getBalance("ancien3"), 15, "même cumul : rien de plus");
  await handleStripeEvent(invoiceRefund("evt_ancien3_r2", "pi_ancien3_m1", 1490), { lookup: noStripe });
  assert.equal(await credits.getBalance("ancien3"), 5, "le reste (10) en dette : le reliquat est déjà absorbé");
  assert.equal(await credits.subscriptionCredits("ancien3"), 20, "mois en cours intact");
  assert.equal(await suspended("ancien3"), false, "une ancienne facture ne suspend jamais");
});

/** Lignes JSON du journal émises pendant `fn` (stdout et stderr). */
async function captureLogs(fn: () => Promise<unknown>): Promise<Obj[]> {
  const lines: string[] = [];
  const [log, err] = [console.log, console.error];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { await fn(); } finally { [console.log, console.error] = [log, err]; }
  return lines.flatMap((l) => { try { return [JSON.parse(l) as Obj]; } catch { return []; } });
}

test("chaque décision de reprise est journalisée (ignoré, retiré, doublon, montants), sans donnée personnelle", async () => {
  await authRun(`INSERT INTO users (id, email, name) VALUES (?,?,?)`, "journal", "journal@example.test", "Journal");
  await oneMonth("journal");
  const logs = await captureLogs(async () => {
    await handleStripeEvent(benabensRefund("evt_journal_foreign", { id: "ch_journal_f", payment_intent: "pi_journal_foreign", customer: "cus_journal", billing_details: { email: "journal@example.test" } }), { lookup: noStripe });
    await handleStripeEvent(invoiceRefund("evt_journal_partial", "pi_journal_m1", 745), { lookup: noStripe });
    await handleStripeEvent(invoiceRefund("evt_journal_partial", "pi_journal_m1", 745), { lookup: noStripe }); // rejeu
    await handleStripeEvent(invoiceRefund("evt_journal_same", "pi_journal_m1", 745), { lookup: noStripe }); // même cumul
  });
  const decisions = logs.filter((l) => l.evt === "stripe.reversal_decision");
  const by = (pi: string, decision: string) => decisions.find((d) => d.paymentIntent === pi && d.decision === decision);
  assert.ok(by("pi_journal_foreign", "ignored:foreign"), JSON.stringify(decisions));
  const retired = by("pi_journal_m1", "invoice-reversed");
  assert.ok(retired, JSON.stringify(decisions));
  assert.deepEqual(
    { amountCents: retired.amountCents, totalCents: retired.totalCents, retiredCenti: retired.retiredCenti, debtCenti: retired.debtCenti, suspended: retired.suspended, currentPeriod: retired.currentPeriod },
    { amountCents: 745, totalCents: 1490, retiredCenti: 1000, debtCenti: 0, suspended: false, currentPeriod: true },
  );
  assert.ok(by("pi_journal_m1", "duplicate"), "rejeu du même événement journalisé");
  assert.ok(by("pi_journal_m1", "reversal-duplicate"), "même cumul sous un autre événement journalisé");
  const all = JSON.stringify(logs);
  for (const personal of ["journal@example.test", "\"journal\"", "cus_journal", "Client Fictif"]) {
    assert.ok(!all.includes(personal), `donnée personnelle dans le journal : ${personal}`);
  }
});

test("route signée (signature de test) : remboursement partiel d'une facture connue → 200, prorata, pas de suspension ; signature fausse → 400", async () => {
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../app/api/billing/webhook/route");
  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe("sk_test_fictive_local_only");
  const signed = (event: Obj, secret = "whsec_test_fictive_local") => {
    const payload = JSON.stringify(event);
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret });
    return new NextRequest("http://localhost/api/billing/webhook", { method: "POST", body: payload, headers: { "stripe-signature": sig } });
  };
  // Facture connue chez nous : la charge s'y rattache par son payment_intent, sans rien demander à Stripe.
  await oneMonth("route");
  const forged = await POST(signed(invoiceRefund("evt_route_forged", "pi_route_m1", 1490), "whsec_autre_secret"));
  assert.equal(forged.status, 400);
  assert.equal(await credits.subscriptionCredits("route"), 20, "signature fausse : rien retiré");

  const res = await POST(signed(invoiceRefund("evt_route_partial", "pi_route_m1", 298)));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.action, "invoice-reversed", JSON.stringify(body));
  assert.equal(await credits.subscriptionCredits("route"), 16, "2,98 € sur 14,90 € = 1/5 → 4 crédits retirés");
  assert.equal(await suspended("route"), false);
  const again = await POST(signed(invoiceRefund("evt_route_partial", "pi_route_m1", 298)));
  assert.equal((await again.json()).action, "duplicate");
  assert.equal(await credits.subscriptionCredits("route"), 16);
});

test("résiliation PUIS remboursement de la facture en cours (ordre habituel) : rien consommé → rien en dette, les crédits achetés restent", async () => {
  await handleStripeEvent(packCheckout("evt_resil_pack", "resil", "cs_resil", "pi_resil_pack"), { lookup: noStripe });
  await oneMonth("resil");
  assert.equal(await credits.getBalance("resil"), 30);
  await handleStripeEvent(ev("evt_resil_del", "customer.subscription.deleted", { id: "sub_resil", customer: "cus_resil", status: "canceled", metadata: { app: "cortex" } }), { lookup: noStripe });
  const r = await handleStripeEvent(invoiceRefund("evt_resil_ref", "pi_resil_m1", 1490), { lookup: noStripe });
  assert.equal(r.action, "invoice-reversed", JSON.stringify(r));
  assert.equal(r.debtCenti, 0, JSON.stringify(r));
  assert.equal(await credits.getBalance("resil"), 10, "les 10 crédits du pack, payés à part, ne paient pas un mois inutilisé");
});

test("abonnement freelance sur un client déjà lié, sans marque Cortex : sa résiliation ne touche pas l'abonnement Cortex", async () => {
  await oneMonth("double");
  const r = await handleStripeEvent(ev("evt_double_del", "customer.subscription.deleted", { id: "sub_freelance_double", customer: "cus_double", status: "canceled", metadata: {}, items: { data: [{ price: "price_freelance_retainer" }] } }), { lookup: noStripe });
  assert.equal(r.action, "ignored:foreign", JSON.stringify(r));
  assert.equal(await credits.subscriptionCredits("double"), 20);
});
