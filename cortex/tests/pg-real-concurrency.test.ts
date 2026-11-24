// Mécanique écrite avec le Pro à 20 crédits/mois (défaut avant le 25/11/2026, 30 depuis) : figé ici.
process.env.SUBSCRIPTION_MONTHLY_CREDITS = "20";
process.env.CREDITS_COST_JSON = JSON.stringify({ exam: 6, qcm: 4, exercise: 1, "lab-exercise": 1, blueprint: 1, format: 1, prepare: 2, assist: 0.3 });

/**
 * CONCURRENCE SUR UN VRAI POSTGRES (connexions réellement parallèles), activée
 * par CORTEX_TEST_PG_URL — sautée sinon. PGlite sérialise tout sur une seule
 * connexion : il prouve la logique, pas le verrou. Ici, pool de 8 connexions,
 * une transaction par réservation : c'est `pg_advisory_xact_lock(hashtext(user))`
 * qui doit tenir. La base doit être DÉDIÉE aux tests : son nom doit contenir
 * « test », et elle est vidée (schéma public recréé, schémas t_* droppés).
 *
 *   CORTEX_TEST_PG_URL=postgres://postgres@localhost:55432/cortextest npx tsx --test tests/pg-real-concurrency.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

const URL_ = process.env.CORTEX_TEST_PG_URL ?? "";
const dbName = (() => { try { return new URL(URL_).pathname.replace(/^\//, ""); } catch { return ""; } })();
const ENABLED = !!URL_ && /test/i.test(dbName);
const skip = ENABLED ? false : "CORTEX_TEST_PG_URL absente (ou base sans « test » dans son nom)";

if (ENABLED) {
  process.env.DB_DRIVER = "postgres";
  process.env.DATABASE_URL = URL_;
  process.env.PG_AUTH_POOL_MAX = "8";
  process.env.PG_POOL_MAX = "8";
  process.env.BILLING_ENABLED = "1";
  process.env.SIGNUP_FREE_CREDITS = "6";
  // Budget IA lié au revenu (testé dans ai-budget.test.ts) : ici, les comptes sont financés par des crédits offerts.
  process.env.AI_BUDGET_MARGIN = "unlimited";
  process.env.DAILY_GEN_QUOTA = "unlimited";
  process.env.DAILY_ASSIST_QUOTA = "unlimited";
  process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
  process.env.MAX_ACTIVE_JOBS = "unlimited";
  process.env.LLM_PROVIDER = "anthropic"; // indisponible sans clé : aucun appel réseau
  delete process.env.LLM_API_KEY; delete process.env.ANTHROPIC_API_KEY;
}

const N = 8;

async function wipe() {
  const postgres = (await import("postgres")).default;
  const sql = postgres(URL_, { max: 1, onnotice: () => {} });
  try {
    const schemas = await sql<{ nspname: string }[]>`SELECT nspname FROM pg_namespace WHERE nspname LIKE 't\\_%'`;
    for (const s of schemas) await sql.unsafe(`DROP SCHEMA IF EXISTS "${s.nspname}" CASCADE`);
    await sql.unsafe(`DROP SCHEMA IF EXISTS public CASCADE`);
    await sql.unsafe(`CREATE SCHEMA public`);
  } finally { await sql.end(); }
}

before(async () => {
  if (!ENABLED) return;
  delete process.env.CORTEX_USER;
  await wipe();
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(async () => {
  if (!ENABLED) return;
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL", "PG_AUTH_POOL_MAX", "PG_POOL_MAX", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "AI_BUDGET_MARGIN", "DAILY_GEN_QUOTA", "DAILY_ASSIST_QUOTA", "RATE_LIMIT_PER_USER_MIN", "MAX_ACTIVE_JOBS", "LLM_PROVIDER"]) delete process.env[k];
});

const inCourse = async <T,>(user: string, course: string, fn: () => Promise<T>) => {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  return runWithUser(user, () => runWithCourse(course, fn));
};

test("réservation : solde pour UN examen, 8 réservations sur 8 connexions → exactement 1", { skip }, async () => {
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const credits = await import("../lib/billing/credits");
  const user = "pg_parallel";
  assert.equal(await credits.getBalanceCenti(user), 600);
  const results = await Promise.all(Array.from({ length: N }, (_, i) =>
    inCourse(user, "ml", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: `job:${user}:ml:${i}` }))
  ));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results.map((r) => r.ok)));
  assert.equal(await credits.getBalanceCenti(user), 0);
});

test("quota du jour = 1 : 8 réservations parallèles → exactement 1 comptée", { skip }, async () => {
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const guards = await import("../lib/billing/guards");
  process.env.DAILY_GEN_QUOTA = "1";
  process.env.SIGNUP_FREE_CREDITS = "100";
  try {
    const user = "pg_quota";
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
      inCourse(user, "ml", () => reserveGeneration({ bucket: "gen", kind: "qcm", ref: `job:${user}:ml:${i}` }))
    ));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(await guards.usedToday("gen", user), 1);
  } finally { process.env.DAILY_GEN_QUOTA = "unlimited"; process.env.SIGNUP_FREE_CREDITS = "6"; }
});

test("calcul du jour (lib/billing/limits) : 3 dépensés, fusible 10, 4 attendus par QCM → 8 lancements parallèles, exactement 1", { skip }, async () => {
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const credits = await import("../lib/billing/credits");
  const { authRun } = await import("../db/auth-store");
  const { nowStr } = await import("../db/q");
  const { resetSpendCache } = await import("../lib/billing/usage");
  process.env.SPEND_CAP_PER_USER_USD = "10";
  process.env.AI_JOB_COST_USD_JSON = JSON.stringify({ qcm: 4 });
  try {
    const user = "pg_compute";
    await credits.addTransaction(user, 5000, "test", `test:${user}:topup`);
    await authRun(
      `INSERT INTO llm_usage (user_id, course, provider, model, tokens_in, tokens_out, cost_usd, estimated, job_id, call_site, created_at)
       VALUES (?, 'ml', 'anthropic', 'claude-sonnet-5', 1000, 500, 3, 0, '1', 'qcm:generateBatch', ?)`, user, nowStr());
    resetSpendCache();
    const before = await credits.getBalanceCenti(user);
    // Coût attendu réservé sous verrou (active_jobs.expected_usd) : le 2e lancement voit le 1er.
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
      inCourse(user, "ml", () => reserveGeneration({ bucket: "gen", kind: "qcm", ref: `job:${user}:ml:${i}`, jobSlot: true }))
    ));
    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results.map((r) => (r.ok ? "ok" : r.error))));
    assert.ok(results.every((r) => r.ok || /calcul du jour/i.test(r.error)));
    const debited = results.find((r) => r.ok);
    assert.equal(await credits.getBalanceCenti(user), before - (debited?.ok ? debited.costCenti : 0), "un seul débit");
  } finally { delete process.env.SPEND_CAP_PER_USER_USD; delete process.env.AI_JOB_COST_USD_JSON; }
});

test("assistance : solde pour UN appel, 8 assistGate parallèles → exactement 1", { skip }, async () => {
  const { assistGate } = await import("../lib/billing/reserve");
  const credits = await import("../lib/billing/credits");
  const { runWithUser } = await import("../db/context");
  const user = "pg_assist";
  await credits.addTransaction(user, -570, "test", `test:${user}:-570`); // 600 offerts → 30 = un appel
  process.env.LLM_BASE_URL = "http://127.0.0.1:9/v1"; process.env.LLM_PROVIDER = "openai-compatible"; process.env.LLM_API_KEY = "x";
  try {
    const results = await Promise.all(Array.from({ length: N }, () => runWithUser(user, () => assistGate("drill"))));
    assert.equal(results.filter((r) => r === null).length, 1);
    assert.equal(await credits.getBalanceCenti(user), 0);
  } finally { delete process.env.LLM_BASE_URL; process.env.LLM_PROVIDER = "anthropic"; delete process.env.LLM_API_KEY; }
});

test("abonnement : 6 crédits d'abonnement, 8 réservations parallèles → exactement 1 (deux poches sous verrou)", { skip }, async () => {
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const credits = await import("../lib/billing/credits");
  const { authRun } = await import("../db/auth-store");
  const user = "pg_sub";
  await credits.addTransaction(user, -600, "test", `test:${user}:vide`);
  await credits.grantSubscriptionMonth({ userId: user, customerId: "cus_pg", subscriptionId: "sub_pg", plan: "cortex_pro_monthly", periodEnd: "2099-01-01 00:00:00" });
  await authRun(`UPDATE subscriptions SET remaining = 600 WHERE user_id = ?`, user);
  const results = await Promise.all(Array.from({ length: N }, (_, i) =>
    inCourse(user, "algo", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: `job:${user}:algo:${i}` }))
  ));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(await credits.subscriptionCreditsCenti(user), 0);
  assert.equal(await credits.purchasedBalanceCenti(user), 0, "la poche achetée n'a pas été touchée");
});

test("jobs : 8 createJobExclusive parallèles avec de quoi payer UN examen → un seul job, un seul débit ; démarrage revendiqué une fois", { skip }, async () => {
  const jobs = await import("../lib/jobs");
  const credits = await import("../lib/billing/credits");
  const user = "pg_jobs";
  const results = await inCourse(user, "cs-202", () => Promise.allSettled(Array.from({ length: N }, () => jobs.createJobExclusive("exam"))));
  const ok = results.filter((r): r is PromiseFulfilledResult<{ id: number; existing: boolean; costCenti: number }> => r.status === "fulfilled");
  const ids = new Set(ok.map((r) => r.value.id));
  assert.equal(ids.size, 1, `jobs distincts : ${[...ids].join(",")}`);
  assert.equal(await credits.getBalanceCenti(user), 0);
  const id = [...ids][0];
  const wins = await inCourse(user, "cs-202", () => Promise.all(Array.from({ length: N }, () => jobs.claimJobStart(id))));
  assert.equal(wins.filter(Boolean).length, 1);
});

test("jobs : 8 createJobExclusive parallèles avec de quoi en payer 8 → un seul job, un seul débit, les autres réservations rendues", { skip }, async () => {
  const jobs = await import("../lib/jobs");
  const credits = await import("../lib/billing/credits");
  const user = "pg_jobs_riche";
  // Deux clics, deux onglets : chaque réservation passe (le solde suffit), seule l'insertion
  // départage. Sans verrou, chaque transaction voyait « aucun job actif » et insérait le sien.
  await credits.addTransaction(user, 5000, "test", `test:${user}:topup`);
  const before = await credits.getBalanceCenti(user);
  const results = await inCourse(user, "cs-202", () => Promise.all(Array.from({ length: N }, () => jobs.createJobExclusive("exam"))));
  const ids = new Set(results.map((r) => r.id));
  assert.equal(ids.size, 1, `jobs distincts : ${[...ids].join(",")}`);
  assert.equal(results.filter((r) => !r.existing).length, 1);
  const spent = before - (await credits.getBalanceCenti(user));
  assert.equal(spent, results.find((r) => !r.existing)!.costCenti);
});

test("reprise Stripe : remboursement ET litige simultanés sur le même paiement → une seule reprise", { skip }, async () => {
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  const credits = await import("../lib/billing/credits");
  const user = "pg_refund_race";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ev = (id: string, type: string, object: unknown): any => ({ id, type, data: { object } });
  await handleStripeEvent(ev("evt_race_buy", "checkout.session.completed", { id: "cs_race", mode: "payment", payment_status: "paid", amount_total: 900, payment_intent: "pi_race", metadata: { cortexUserId: user, plan: "credits_10", credits: "10" } }));
  assert.equal(await credits.getBalanceCenti(user), 1600);
  const results = await Promise.all(Array.from({ length: N }, (_, i) =>
    handleStripeEvent(i % 2 === 0
      ? ev(`evt_race_r${i}`, "charge.refunded", { payment_intent: "pi_race", amount: 900, amount_refunded: 900 })
      : ev(`evt_race_d${i}`, "charge.dispute.created", { payment_intent: "pi_race", amount: 900 })),
  ));
  assert.equal(results.filter((r) => r.reversed).length, 1, JSON.stringify(results.map((r) => r.action)));
  assert.equal(await credits.getBalanceCenti(user), 600, "10 repris une seule fois");
});
