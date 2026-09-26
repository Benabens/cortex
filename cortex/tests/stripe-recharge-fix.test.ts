/**
 * RÉGRESSION — deux défauts d'argent corrigés sur `fix-stripe-recharge` :
 *  (a) la recharge calendaire PARESSEUSE ne doit s'appliquer QU'à l'annuel.
 *      Un abonné MENSUEL était rechargé à 20 au changement de mois calendaire
 *      EN PLUS de invoice.paid (qui recharge déjà chaque période) → jusqu'à ~40
 *      crédits pour un seul mois payé si la facturation ne tombe pas le 1er.
 *  (b) customer.subscription.updated : la fin de période doit être lue sur les
 *      ITEMS (SDK Stripe Basil+/Dahlia : `current_period_end` a quitté la
 *      subscription pour vivre sur `items.data[].current_period_end`).
 * Seams : credits.subscriptionCreditsCenti, reserve.reserveGeneration,
 * handleStripeEvent. Store Postgres/PGlite en mémoire ; unités en centièmes.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

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
const monthNow = () => new Date().toISOString().slice(0, 7);
const future = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 19).replace("T", " ");
const futureUnix = (days: number) => Math.floor((Date.now() + days * 86400_000) / 1000);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (id: string, type: string, object: unknown): any => ({ id, type, data: { object } });

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

// ─────────────── (a) recharge paresseuse réservée à l'annuel ───────────────

test("(a) MENSUEL : pas de recharge calendaire — le reliquat reste, invoice.paid seul recharge", async () => {
  const credits = await import("../lib/billing/credits");
  const { authRun } = await import("../db/auth-store");
  await credits.grantSubscriptionMonth({ userId: "m", customerId: "cus_m", subscriptionId: "sub_m", plan: "cortex_pro_monthly", periodEnd: future(20) });
  assert.equal(await credits.subscriptionCreditsCenti("m"), 2000, "octroi initial via invoice.paid");
  // il consomme (reste 5) puis le mois CALENDAIRE tourne avant la prochaine facture
  await authRun(`UPDATE subscriptions SET remaining = 500, month_anchor = ? WHERE user_id = ?`, "2000-01", "m");
  assert.equal(await credits.subscriptionCreditsCenti("m"), 500, "mensuel : PAS rechargé à 20 au changement de mois (sinon double crédit)");
});

test("(a) ANNUEL : recharge calendaire conservée — 20/mois sans nouvelle facture", async () => {
  const credits = await import("../lib/billing/credits");
  const { authRun, authGet } = await import("../db/auth-store");
  await credits.grantSubscriptionMonth({ userId: "y", customerId: "cus_y", subscriptionId: "sub_y", plan: "cortex_pro_yearly", periodEnd: future(365) });
  await authRun(`UPDATE subscriptions SET remaining = 300, month_anchor = ? WHERE user_id = ?`, "2000-01", "y");
  assert.equal(await credits.subscriptionCreditsCenti("y"), 2000, "annuel : rechargé à 20 au changement de mois");
  const s = await authGet<{ month_anchor: string }>(`SELECT month_anchor FROM subscriptions WHERE user_id = ?`, "y");
  assert.equal(s?.month_anchor, monthNow(), "ancre déplacée au mois courant");
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

// ─────────────── (b) fin de période lue sur les items ───────────────

test("(b) subscription.updated : period_end lue sur items.data[] (SDK Basil+)", async () => {
  const credits = await import("../lib/billing/credits");
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  await credits.grantSubscriptionMonth({ userId: "u", customerId: "cus_u", subscriptionId: "sub_u", plan: "cortex_pro_monthly", periodEnd: future(10) });
  const prev = (await credits.getSubscription("u"))?.period_end; // seam public
  const newEndUnix = futureUnix(40);
  await handleStripeEvent(ev("evt_subup_1", "customer.subscription.updated", {
    id: "sub_u", customer: "cus_u", status: "active",
    items: { data: [{ current_period_end: newEndUnix }] }, // Basil+ : plus de current_period_end au niveau subscription
  }));
  const now = (await credits.getSubscription("u"))?.period_end;
  const expected = new Date(newEndUnix * 1000).toISOString().slice(0, 19).replace("T", " ");
  assert.notEqual(now, prev, "la fin de période doit être mise à jour depuis les items");
  assert.equal(now, expected);
});
