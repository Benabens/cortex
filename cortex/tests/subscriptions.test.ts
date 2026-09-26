/**
 * ABONNEMENT PRO SUR LE LEDGER DURCI — deux poches de crédits :
 *  - ACHETÉS (packs, palier gratuit) : ledger `credit_transactions`, permanents ;
 *  - ABONNEMENT : `subscriptions.remaining`, 20 crédits/mois NON reportables,
 *    recharge paresseuse au changement de mois calendaire (l'annuel reçoit 20/mois).
 * Le débit consomme l'abonnement d'abord, DANS la transaction de réservation
 * (aucune course entre les deux poches). Un remboursement rend chaque part dans
 * sa poche d'origine ; la part d'abonnement n'est rendue que si le mois n'a pas
 * changé (sinon elle est perdue, comme le reliquat).
 * Unités internes : centièmes de crédit.
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

test("attribution d'un mois : 20 crédits d'abonnement, solde 20, poche achetée à 0", async () => {
  const credits = await import("../lib/billing/credits");
  await credits.grantSubscriptionMonth({ userId: "pro", customerId: "cus_pro", subscriptionId: "sub_pro", plan: "cortex_pro_monthly", periodEnd: future(30) });
  assert.equal(await credits.subscriptionCreditsCenti("pro"), 2000);
  assert.equal(await credits.getBalanceCenti("pro"), 2000);
  assert.equal(await credits.getBalance("pro"), 20);
  assert.equal(await credits.purchasedBalanceCenti("pro"), 0);
});

test("débit abonnement d'abord : un examen consomme 2 crédits d'abonnement, la poche achetée reste intacte", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { authGet } = await import("../db/auth-store");
  await credits.addTransaction("pro", 1000, "achat", "stripe:cs:pro_pack_1");
  const r = await inMl("pro", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: "job:pro:ml:a" }));
  assert.equal(r.ok, true);
  assert.equal(await credits.subscriptionCreditsCenti("pro"), 1800);
  assert.equal(await credits.purchasedBalanceCenti("pro"), 1000);
  const row = await authGet<{ delta: number; sub_amount: number }>(`SELECT delta, sub_amount FROM credit_transactions WHERE ref = ?`, "job:pro:ml:a");
  assert.deepEqual([Number(row!.delta), Number(row!.sub_amount)], [0, 200], "la ligne du ledger mémorise la part abonnement");
});

test("débit mixte : le reste de l'abonnement puis les crédits achetés, dans la même transaction", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { authRun } = await import("../db/auth-store");
  await authRun(`UPDATE subscriptions SET remaining = 100 WHERE user_id = ?`, "pro"); // il reste 1 crédit d'abo
  const r = await inMl("pro", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: "job:pro:ml:b" }));
  assert.equal(r.ok, true);
  assert.equal(await credits.subscriptionCreditsCenti("pro"), 0);
  assert.equal(await credits.purchasedBalanceCenti("pro"), 900); // 1000 − (200 − 100)
});

test("insuffisant : 1 crédit d'abo + 0,5 acheté < examen à 2 → 402, aucune poche touchée", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { authRun } = await import("../db/auth-store");
  await authRun(`UPDATE subscriptions SET remaining = 100 WHERE user_id = ?`, "pro");
  await credits.addTransaction("pro", -850, "test", "test:pro:down"); // achetés : 50
  const r = await inMl("pro", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: "job:pro:ml:c" }));
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 402);
  assert.match((r as { error: string }).error, /1,5/);
  assert.equal(await credits.subscriptionCreditsCenti("pro"), 100);
  assert.equal(await credits.purchasedBalanceCenti("pro"), 50);
});

test("remboursement dans la poche d'origine : même mois → l'abonnement récupère sa part ; mois suivant → part d'abo perdue", async () => {
  const credits = await import("../lib/billing/credits");
  const { authRun } = await import("../db/auth-store");
  // job:pro:ml:b a débité 100 d'abo + 100 achetés.
  await credits.refundGeneration("exam", "job:pro:ml:b", "pro");
  assert.equal(await credits.subscriptionCreditsCenti("pro"), 200);
  assert.equal(await credits.purchasedBalanceCenti("pro"), 150);
  // job:pro:ml:a (200 d'abo) : on fait comme si le mois avait tourné depuis le débit.
  await authRun(`UPDATE credit_transactions SET created_at = ? WHERE ref = ?`, "2001-01-15 10:00:00", "job:pro:ml:a");
  await credits.refundGeneration("exam", "job:pro:ml:a", "pro");
  assert.equal(await credits.subscriptionCreditsCenti("pro"), 200, "la part d'abonnement d'un autre mois n'est pas reportée");
  assert.equal(await credits.purchasedBalanceCenti("pro"), 150, "rien à rendre côté achetés");
  // idempotent
  await credits.refundGeneration("exam", "job:pro:ml:b", "pro");
  assert.equal(await credits.subscriptionCreditsCenti("pro"), 200);
});

test("recharge paresseuse au changement de mois, DANS la réservation (annuel : 20/mois sans nouvelle facture)", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { authRun } = await import("../db/auth-store");
  await credits.grantSubscriptionMonth({ userId: "yearly", customerId: "cus_y", subscriptionId: "sub_y", plan: "cortex_pro_yearly", periodEnd: future(365) });
  await authRun(`UPDATE subscriptions SET remaining = 300, month_anchor = ? WHERE user_id = ?`, "2000-01", "yearly");
  const r = await inMl("yearly", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: "job:yearly:ml:a" }));
  assert.equal(r.ok, true);
  assert.equal(await credits.subscriptionCreditsCenti("yearly"), 1800, "20 rechargés puis 2 consommés (le reliquat de 3 est perdu)");
  const { authGet } = await import("../db/auth-store");
  const s = await authGet<{ month_anchor: string }>(`SELECT month_anchor FROM subscriptions WHERE user_id = ?`, "yearly");
  assert.equal(s?.month_anchor, monthNow());
});

test("période terminée ou résiliée : plus de crédits d'abonnement, les achetés restent", async () => {
  const credits = await import("../lib/billing/credits");
  const { authRun } = await import("../db/auth-store");
  await authRun(`UPDATE subscriptions SET period_end = ? WHERE user_id = ?`, "2000-01-01 00:00:00", "yearly");
  assert.equal(await credits.subscriptionCreditsCenti("yearly"), 0);
  await credits.setSubscriptionStatus({ userId: "pro", status: "canceled", clearRemaining: true });
  assert.equal(await credits.subscriptionCreditsCenti("pro"), 0);
  assert.equal(await credits.purchasedBalanceCenti("pro"), 150);
});

test("concurrence : 2 crédits d'abonnement, 0 acheté, 8 réservations parallèles → exactement 1", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  await credits.grantSubscriptionMonth({ userId: "race", customerId: "cus_r", subscriptionId: "sub_r", plan: "cortex_pro_monthly", periodEnd: future(30) });
  const { authRun } = await import("../db/auth-store");
  await authRun(`UPDATE subscriptions SET remaining = 200 WHERE user_id = ?`, "race"); // de quoi payer UN examen
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    inMl("race", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: `job:race:ml:${i}` }))
  ));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(await credits.subscriptionCreditsCenti("race"), 0);
  assert.equal(await credits.purchasedBalanceCenti("race"), 0);
});
