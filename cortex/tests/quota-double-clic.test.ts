/**
 * DOUBLE CLIC — deux onglets ou un double clic sur « Générer » lancent la même création
 * en parallèle. Un seul job naît et un seul débit reste (reservation.test.ts) ; la
 * génération du quota du jour réservée par la création perdue est rendue avec son crédit :
 * sinon, avec le quota de prod à 3, un triple clic laissait une seule génération.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

const ENV: Record<string, string> = {
  DB_DRIVER: "postgres",
  DATABASE_URL: "pglite://memory",
  AI_BUDGET_MARGIN: "unlimited",
  BILLING_ENABLED: "1",
  SIGNUP_FREE_CREDITS: "20",
  DAILY_GEN_QUOTA: "10",
  DAILY_ASSIST_QUOTA: "unlimited",
  RATE_LIMIT_PER_USER_MIN: "unlimited",
  MAX_ACTIVE_JOBS: "unlimited",
  MAX_GLOBAL_JOBS: "unlimited",
};

/**
 * Sous Node 22, `tsx --test` charge tous les fichiers dans UN process : les variables posées en
 * tête de fichier par les autres suites (tarifs, propriétaire, plafonds) écrasent les nôtres.
 * Elles sont donc reposées juste avant nos tests, et les surcharges étrangères effacées.
 */
const FOREIGN = ["CREDITS_COST_JSON", "AI_JOB_COST_USD_JSON", "CORTEX_OWNER_USER_ID", "CORTEX_OWNER_EMAIL", "SPEND_CAP_USD", "SPEND_CAP_BASE_USD", "SPEND_CAP_PER_USER_USD", "SPEND_CAP_PER_USER_FLOOR_USD", "AI_BUDGET_FREE_USD", "E2E_TEST_AUTH", "E2E_TEST_RUN"];
function applyEnv(): void {
  Object.assign(process.env, ENV);
  for (const k of FOREIGN) delete process.env[k];
}
applyEnv();

import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";
import { q } from "../db/q";

before(async () => {
  applyEnv();
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of Object.keys(ENV)) delete process.env[k];
});

test("6 créations simultanées du même QCM : un job, un débit, une seule génération du quota du jour", async () => {
  const jobs = await import("../lib/jobs");
  const credits = await import("../lib/billing/credits");
  const { usedToday } = await import("../lib/billing/guards");
  const user = "usr_double_clic";
  const start = await credits.getBalanceCenti(user);
  const target = JSON.stringify({ count: 20, openCount: 3 });
  const results = await runWithUser(user, () => runWithCourse("ml", () =>
    Promise.all(Array.from({ length: 6 }, () => jobs.createJobExclusive("qcm", target)))));
  assert.equal(new Set(results.map((r) => r.id)).size, 1, "un seul job");
  const rows = await runWithUser(user, () => runWithCourse("ml", () => q.all(`SELECT id FROM jobs WHERE type = 'qcm'`)));
  assert.equal(rows.length, 1);
  assert.equal(start - (await credits.getBalanceCenti(user)), 100, "un seul crédit débité");
  assert.equal(await usedToday("gen", user), 1, "les clics perdus ne consomment pas le quota du jour");
});
