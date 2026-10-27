/**
 * MODE PROPRIÉTAIRE — le compte de CORTEX_OWNER_EMAIL n'est jamais arrêté par
 * les crédits, les quotas du jour ni le plafond de générations simultanées :
 * rien n'est débité ni compté contre lui. Les plafonds de DÉPENSE (par compte et
 * global) restent actifs, et les autres comptes ne voient aucun changement.
 * Postgres réel (PGlite), facturation active, limites serrées.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "0";
process.env.DAILY_GEN_QUOTA = "1";
process.env.DAILY_ASSIST_QUOTA = "1";
process.env.RATE_LIMIT_PER_USER_MIN = "2";
process.env.MAX_ACTIVE_JOBS = "1";
process.env.CORTEX_OWNER_EMAIL = "Ben@Example.com";
delete process.env.CORTEX_OWNER_USER_ID;

import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";

const OWNER = "usr_owner_mode";
const OTHER = "usr_other_mode";
const ENV_KEYS = ["DB_DRIVER", "DATABASE_URL", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_GEN_QUOTA", "DAILY_ASSIST_QUOTA",
  "RATE_LIMIT_PER_USER_MIN", "MAX_ACTIVE_JOBS", "CORTEX_OWNER_EMAIL", "SPEND_CAP_USD", "SPEND_CAP_PER_USER_USD"];

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { authRun } = await import("../db/auth-store");
  await authRun(`INSERT INTO users (id, email, name) VALUES (?,?,?)`, OWNER, "ben@example.com", "Ben");
  await authRun(`INSERT INTO users (id, email, name) VALUES (?,?,?)`, OTHER, "alice@example.com", "Alice");
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ENV_KEYS) delete process.env[k];
});

const as = <T>(user: string, fn: () => Promise<T>) => runWithUser(user, () => runWithCourse("ml", fn));

test("propriétaire : générations au-delà du solde, du quota du jour et des places simultanées, rien débité ni compté", async () => {
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const credits = await import("../lib/billing/credits");
  const results = [];
  for (let i = 1; i <= 4; i++) {
    results.push(await as(OWNER, () => reserveGeneration({ bucket: "gen", kind: "exam", ref: `job:${OWNER}:ml:${i}`, jobSlot: true })));
  }
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, true]);
  assert.deepEqual(results.map((r) => (r.ok ? r.costCenti : -1)), [0, 0, 0, 0]);
  assert.equal(await credits.getBalanceCenti(OWNER), 0, "aucun débit : le solde n'est jamais entamé");
  const { authGet } = await import("../db/auth-store");
  const counted = await authGet<{ n: number }>(`SELECT count(*) n FROM gen_events WHERE user_id = ?`, OWNER);
  assert.equal(Number(counted?.n), 0, "rien n'est compté contre le propriétaire");
});

test("autre compte, mêmes réglages : solde, quota du jour et places simultanées s'appliquent toujours", async () => {
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const credits = await import("../lib/billing/credits");
  const broke = await as(OTHER, () => reserveGeneration({ bucket: "gen", kind: "exam", ref: `job:${OTHER}:ml:1`, jobSlot: true }));
  assert.equal(broke.ok, false);
  assert.equal(!broke.ok && broke.status, 402, "sans crédit : refusé");

  await credits.addTransaction(OTHER, 1000, "test", "test:other-topup");
  const first = await as(OTHER, () => reserveGeneration({ bucket: "gen", kind: "exam", ref: `job:${OTHER}:ml:2`, jobSlot: true }));
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.costCenti, 200, "un examen coûte 2 crédits");
  const second = await as(OTHER, () => reserveGeneration({ bucket: "gen", kind: "exam", ref: `job:${OTHER}:ml:3`, jobSlot: true }));
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.status, 429, "quota du jour (1) atteint");
  assert.equal(await credits.getBalanceCenti(OTHER), 800);
});

test("pré-contrôles des routes et du MCP : le propriétaire passe sans solde ni quota restant, l'autre compte est refusé", async () => {
  const { generationGate, recordGeneration } = await import("../lib/billing/guards");
  const { creditsGate } = await import("../lib/billing/credits");
  // Activité du jour antérieure au mode propriétaire : le quota d'assistance (1) est déjà consommé.
  await as(OWNER, () => recordGeneration("assist", "drill"));
  await as(OTHER, () => recordGeneration("assist", "drill"));
  assert.equal(await as(OWNER, () => generationGate("assist")), null);
  assert.equal(await as(OWNER, () => creditsGate("exam")), null);
  assert.equal((await as(OTHER, () => generationGate("assist")))?.status, 429);
  assert.equal((await as("usr_broke_mode", () => creditsGate("exam")))?.status, 402);
});

test("dépense : les plafonds de dépense, par compte et global, arrêtent le propriétaire comme tout le monde ; ses coûts restent enregistrés", async () => {
  // Une boucle d'agent ou un jeton volé sur le compte du propriétaire ne doit pas épuiser
  // le plafond global du mois, qui couperait la génération de TOUS les comptes.
  const usage = await import("../lib/billing/usage");
  const { authGet } = await import("../db/auth-store");
  process.env.SPEND_CAP_PER_USER_USD = "1";
  process.env.SPEND_CAP_USD = "100";
  const isSpendCap = (e: unknown) => (e as { code?: string }).code === "SPEND_CAP";
  try {
    usage.resetSpendCache();
    await as(OWNER, () => usage.assertSpendCap("anthropic"));
    // 2 $ dépensés aujourd'hui par chacun : au-dessus du plafond par compte (1 $).
    for (const user of [OWNER, OTHER]) {
      await as(user, () => usage.recordUsage({ provider: "anthropic", model: "claude-sonnet-5", tokensIn: 2 * 500_000 }));
    }
    const logged = await authGet<{ n: number }>(`SELECT count(*) n FROM llm_usage WHERE user_id = ?`, OWNER);
    assert.equal(Number(logged?.n), 1, "le coût du propriétaire est enregistré comme d'habitude");
    for (const user of [OWNER, OTHER]) await assert.rejects(() => as(user, () => usage.assertSpendCap("anthropic")), isSpendCap, user);

    process.env.SPEND_CAP_PER_USER_USD = "unlimited";
    process.env.SPEND_CAP_USD = "3"; // 4 $ dépensés ce mois-ci au total
    usage.resetSpendCache();
    await assert.rejects(() => as(OWNER, () => usage.assertSpendCap("anthropic")), isSpendCap);
  } finally {
    delete process.env.SPEND_CAP_PER_USER_USD;
    delete process.env.SPEND_CAP_USD;
    usage.resetSpendCache();
  }
});

test("opt-in : sans CORTEX_OWNER_EMAIL ni CORTEX_OWNER_USER_ID, personne n'est exempté — pas même « owner » du mode mono-utilisateur", async () => {
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { OWNER_USER } = await import("../db/context");
  delete process.env.CORTEX_OWNER_EMAIL;
  try {
    for (const user of [OWNER, OWNER_USER]) {
      const r = await as(user, () => reserveGeneration({ bucket: "gen", kind: "exam", ref: `job:${user}:ml:optin` }));
      assert.equal(r.ok, false, user);
      assert.equal(!r.ok && r.status, 402, user);
    }
  } finally {
    process.env.CORTEX_OWNER_EMAIL = "Ben@Example.com";
  }
});

test("Mon compte (/api/billing) : aucune limite du jour affichée au propriétaire, celles de l'autre compte inchangées", async () => {
  const { NextRequest } = await import("next/server");
  const billing = await import("../app/api/billing/route");
  const quotasOf = async (user: string) => {
    const res = await billing.GET(new NextRequest("http://cortex.test/api/billing", { headers: { "x-cortex-user": user } }) as never);
    return ((await res.json()) as { quotas: unknown }).quotas;
  };
  assert.deepEqual(await quotasOf(OWNER), { gen: null, assist: null });
  assert.deepEqual(await quotasOf(OTHER), { gen: 1, assist: 1 });
});
