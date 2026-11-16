/**
 * DOUBLE CLIC — deux onglets ou un double clic sur « Générer » lancent la même création
 * en parallèle. Un seul job naît et un seul débit reste (reservation.test.ts) ; la
 * génération du quota du jour réservée par la création perdue est rendue avec son crédit :
 * sinon, avec le quota de prod à 3, un triple clic laissait une seule génération.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.AI_BUDGET_MARGIN = "unlimited";
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "20";
process.env.DAILY_GEN_QUOTA = "10";
process.env.DAILY_ASSIST_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.MAX_ACTIVE_JOBS = "unlimited";
process.env.MAX_GLOBAL_JOBS = "unlimited";

import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";
import { q } from "../db/q";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL", "AI_BUDGET_MARGIN", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_GEN_QUOTA", "DAILY_ASSIST_QUOTA", "RATE_LIMIT_PER_USER_MIN", "MAX_ACTIVE_JOBS", "MAX_GLOBAL_JOBS"]) delete process.env[k];
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
