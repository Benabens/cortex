/**
 * RÉGRESSION — deux défauts d'argent de la recharge d'abonnement Stripe
 * (septembre 2026), exprimés dans la règle en vigueur : fenêtres ancrées sur
 * la période de facturation (lib/billing/subscription-windows), et non sur le
 * mois civil.
 *  (a) Un abonné MENSUEL était rechargé à 20 au changement de mois calendaire
 *      EN PLUS de invoice.paid (qui recharge déjà chaque période) → jusqu'à ~40
 *      crédits pour un seul mois payé si la facturation ne tombe pas le 1er.
 *      L'ANNUEL garde ses 20 par mois sans nouvelle facture ; une ligne HÉRITÉE
 *      (écrite avant les fenêtres : `month_anchor` seul) les reçoit au mois
 *      civil comme avant, puis par fenêtre dès que le début de sa période est
 *      connu. Un plan INCONNU est classé par la durée de sa période (annuel
 *      au-delà de 45 jours).
 *  (b) customer.subscription.updated porte la période que Stripe ANNONCE, sur
 *      la subscription (ancien format d'API) ou sur ses ITEMS (format récent,
 *      famille « basil »). Dans les deux formats elle n'est PAS recopiée : la
 *      période qui donne des crédits est celle d'une facture payée (invoice.paid).
 *      Recopiée, elle offrait le mois à un renouvellement impayé — scénarios
 *      complets dans tests/subscription-unpaid.test.ts.
 * Seams : credits.subscriptionCreditsCenti, credits.getSubscription,
 * reserve.reserveGeneration, handleStripeEvent. Store Postgres/PGlite en
 * mémoire ; unités en centièmes.
 */
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "0";
process.env.DAILY_GEN_QUOTA = "unlimited";
process.env.DAILY_ASSIST_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.MAX_ACTIVE_JOBS = "unlimited";

import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";

const inMl = <T,>(user: string, fn: () => Promise<T>) => runWithUser(user, () => runWithCourse("ml", fn));
const future = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 19).replace("T", " ");
const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (id: string, type: string, object: unknown): any => ({ id, type, data: { object } });
/** customer.subscription.updated pour l'abonnement de `user` ; `fields` porte la période là où le format d'API la met. */
const subUpdated = (id: string, user: string, status: string, fields: Record<string, unknown>) =>
  ev(id, "customer.subscription.updated", { id: `sub_${user}`, customer: `cus_${user}`, status, ...fields });

/** Horloge simulée le temps d'un scénario daté, puis rendue : les autres tests vivent en dates relatives. */
async function withClock(startIso: string, scenario: (at: (iso: string) => void) => Promise<void>): Promise<void> {
  mock.timers.enable({ apis: ["Date"], now: new Date(startIso).getTime() });
  try {
    await scenario((iso) => mock.timers.setTime(new Date(iso).getTime()));
  } finally {
    mock.timers.reset();
  }
}
/** Ligne d'abonnement telle que le code d'avant les fenêtres l'a laissée : ancre calendaire seule. */
async function legacySubscription(user: string, plan: string, remaining: number, periodEnd: string, monthAnchor: string): Promise<void> {
  const { authRun } = await import("../db/auth-store");
  await authRun(
    `INSERT INTO subscriptions (user_id, customer_id, subscription_id, status, plan, monthly_credits, remaining, period_end, month_anchor, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    user, `cus_${user}`, `sub_${user}`, "active", plan, 2000, remaining, periodEnd, monthAnchor, `${monthAnchor}-01 08:00:00`,
  );
}

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_GEN_QUOTA", "DAILY_ASSIST_QUOTA", "RATE_LIMIT_PER_USER_MIN", "MAX_ACTIVE_JOBS"]) delete process.env[k];
});

// ─────────────── (a) recharge paresseuse : jamais pour le mensuel, par fenêtre pour l'annuel ───────────────

test("(a) MENSUEL : pas de recharge calendaire — le reliquat reste, invoice.paid seul recharge", async () => {
  const credits = await import("../lib/billing/credits");
  const { authRun } = await import("../db/auth-store");
  await credits.grantSubscriptionMonth({ userId: "m", customerId: "cus_m", subscriptionId: "sub_m", plan: "cortex_pro_monthly", periodEnd: future(20) });
  assert.equal(await credits.subscriptionCreditsCenti("m"), 2000, "octroi initial via invoice.paid");
  // il consomme (reste 5) puis le mois CALENDAIRE tourne avant la prochaine facture
  await authRun(`UPDATE subscriptions SET remaining = 500, month_anchor = ? WHERE user_id = ?`, "2000-01", "m");
  assert.equal(await credits.subscriptionCreditsCenti("m"), 500, "mensuel : PAS rechargé à 20 au changement de mois (sinon double crédit)");
});

test("(a) ANNUEL hérité (month_anchor seul) : 20 par mois civil comme avant, une seule fois par mois, rien après la fin de période", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  await withClock("2026-09-28T12:00:00Z", async (at) => {
    // annuel facturé un 15/03 par l'ancien code : il lui reste 3 crédits de septembre
    await legacySubscription("yold", "cortex_pro_yearly", 300, "2027-03-15 10:00:00", "2026-09");
    assert.equal(await credits.subscriptionCreditsCenti("yold"), 300, "septembre déjà ouvert : rien de perdu, rien de rechargé");
    at("2026-10-01T00:00:00Z");
    assert.equal(await credits.subscriptionCreditsCenti("yold"), 2000, "octobre : 20 sans nouvelle facture");
    assert.equal((await inMl("yold", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: "job:yold:ml:1" }))).ok, true);
    at("2026-10-20T00:00:00Z");
    assert.equal(await credits.subscriptionCreditsCenti("yold"), 1800, "pas de seconde recharge dans le même mois");
    at("2026-11-01T00:00:00Z");
    assert.equal((await inMl("yold", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: "job:yold:ml:2" }))).ok, true, "la réservation recharge dans sa transaction");
    assert.equal(await credits.subscriptionCreditsCenti("yold"), 1800, "20 rechargés en novembre puis 2 consommés");
    at("2027-03-15T10:00:00Z");
    assert.equal(await credits.subscriptionCreditsCenti("yold"), 0, "fin de période : plus rien sans nouvelle facture");
  });
});

test("(a) ANNUEL hérité puis facture payée : les fenêtres passent sur la période, le 1er du mois ne recharge plus", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  await withClock("2027-03-15T10:00:00Z", async (at) => {
    await legacySubscription("yrenew", "cortex_pro_yearly", 300, "2027-03-15 10:00:00", "2027-03");
    await handleStripeEvent(ev("evt_yrenew_inv", "invoice.paid", {
      id: "in_yrenew", customer: "cus_yrenew", subscription: "sub_yrenew", payment_intent: "pi_yrenew",
      lines: { data: [{ period: { start: unix("2027-03-15T10:00:00Z"), end: unix("2028-03-15T10:00:00Z") }, price: { lookup_key: "cortex_pro_yearly" } }] },
    }));
    assert.equal(await credits.subscriptionCreditsCenti("yrenew"), 2000, "la facture payée ouvre 20");
    assert.equal((await inMl("yrenew", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: "job:yrenew:ml:1" }))).ok, true);
    at("2027-04-01T00:00:00Z");
    assert.equal(await credits.subscriptionCreditsCenti("yrenew"), 1800, "le 1er avril n'est plus une fenêtre : pas de double régime");
    at("2027-04-15T10:00:00Z");
    assert.equal(await credits.subscriptionCreditsCenti("yrenew"), 2000, "fenêtre du 15/04, ancrée sur la période facturée");
  });
});

test("(a) plan INCONNU, période d'un an : traité en annuel, 20 par fenêtre ancrée sur la période", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  await withClock("2026-05-10T09:00:00Z", async (at) => {
    await credits.grantSubscriptionMonth({ userId: "noplan-y", customerId: "cus_noplan-y", subscriptionId: "sub_noplan-y", plan: null, periodStart: "2026-05-10 09:00:00", periodEnd: "2027-05-10 09:00:00" });
    assert.equal((await inMl("noplan-y", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: "job:noplan-y:ml:1" }))).ok, true);
    at("2026-06-01T00:00:00Z");
    assert.equal(await credits.subscriptionCreditsCenti("noplan-y"), 1800, "le 1er juin n'est pas une fenêtre");
    at("2026-06-10T09:00:00Z");
    assert.equal(await credits.subscriptionCreditsCenti("noplan-y"), 2000, "fenêtre du 10/06 : la durée de la période suffit à reconnaître l'annuel");
  });
});

test("(a) plan INCONNU, période de 40 jours : traité en mensuel, aucune recharge paresseuse", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  await withClock("2026-05-10T09:00:00Z", async (at) => {
    // 40 jours : sous le seuil de 45, mais assez long pour qu'une fenêtre s'ouvre le 10/06 si le plan était pris pour un annuel
    await credits.grantSubscriptionMonth({ userId: "noplan-m", customerId: "cus_noplan-m", subscriptionId: "sub_noplan-m", plan: null, periodStart: "2026-05-10 09:00:00", periodEnd: "2026-06-19 09:00:00" });
    assert.equal((await inMl("noplan-m", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: "job:noplan-m:ml:1" }))).ok, true);
    at("2026-06-01T00:00:00Z");
    assert.equal(await credits.subscriptionCreditsCenti("noplan-m"), 1800, "pas de recharge au 1er");
    at("2026-06-10T09:00:00Z");
    assert.equal(await credits.subscriptionCreditsCenti("noplan-m"), 1800, "un mois après le début : pas de fenêtre pour un mensuel");
    at("2026-06-19T09:00:00Z");
    assert.equal(await credits.subscriptionCreditsCenti("noplan-m"), 0, "période échue : seule une facture payée recrédite");
  });
});

test("(a) MENSUEL via la réservation : pas de recharge au changement de mois", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { authRun } = await import("../db/auth-store");
  await authRun(`UPDATE subscriptions SET remaining = 500, month_anchor = ? WHERE user_id = ?`, "2000-01", "m");
  const r = await inMl("m", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: "job:m:ml:1" }));
  assert.equal(r.ok, true);
  assert.equal(await credits.subscriptionCreditsCenti("m"), 300, "5 − 2 = 3, aucune recharge à 20 dans la réservation");
});

// ─────────────── (b) la période annoncée par subscription.updated n'est jamais recopiée ───────────────

test("(b) subscription.updated, format récent (période sur items.data[]) : la période payée ne bouge pas", async () => {
  const credits = await import("../lib/billing/credits");
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  await credits.grantSubscriptionMonth({ userId: "ustart", customerId: "cus_ustart", subscriptionId: "sub_ustart", plan: "cortex_pro_yearly", periodStart: "2026-01-31 10:00:00", periodEnd: "2027-01-31 10:00:00" });
  await handleStripeEvent(subUpdated("evt_subup_start", "ustart", "active", {
    items: { data: [{ current_period_start: unix("2027-01-31T10:00:00Z"), current_period_end: unix("2028-01-31T10:00:00Z") }] }, // l'item seul porte la période
  }));
  const s = await credits.getSubscription("ustart");
  assert.equal(s?.period_start, "2026-01-31 10:00:00", "le début de la période payée ancre toujours les fenêtres");
  assert.equal(s?.period_end, "2027-01-31 10:00:00", "la fin reste celle de la facture payée");
});

test("(b) subscription.updated, ancien format (période sur la subscription) : la période payée ne bouge pas", async () => {
  const credits = await import("../lib/billing/credits");
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  await credits.grantSubscriptionMonth({ userId: "uold", customerId: "cus_uold", subscriptionId: "sub_uold", plan: "cortex_pro_monthly", periodStart: "2026-09-28 10:00:00", periodEnd: "2026-10-28 10:00:00" });
  await handleStripeEvent(subUpdated("evt_subup_old", "uold", "active", {
    current_period_start: unix("2026-10-28T10:00:00Z"), current_period_end: unix("2026-11-28T10:00:00Z"),
    items: { data: [{ price: { lookup_key: "cortex_pro_monthly" } }] }, // l'item ne porte que le prix
  }));
  const s = await credits.getSubscription("uold");
  assert.equal(s?.period_start, "2026-09-28 10:00:00");
  assert.equal(s?.period_end, "2026-10-28 10:00:00");
});

test("(b) subscription.updated sans période : le statut suit, la période connue est conservée", async () => {
  const credits = await import("../lib/billing/credits");
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  await credits.grantSubscriptionMonth({ userId: "ukeep", customerId: "cus_ukeep", subscriptionId: "sub_ukeep", plan: "cortex_pro_monthly", periodStart: "2026-09-28 10:00:00", periodEnd: "2026-10-28 10:00:00" });
  await handleStripeEvent(subUpdated("evt_subup_keep", "ukeep", "past_due", {
    items: { data: [{ price: { lookup_key: "cortex_pro_monthly" } }] },
  }));
  const s = await credits.getSubscription("ukeep");
  assert.equal(s?.status, "past_due");
  assert.equal(s?.period_start, "2026-09-28 10:00:00");
  assert.equal(s?.period_end, "2026-10-28 10:00:00");
});
