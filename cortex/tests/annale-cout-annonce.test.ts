/**
 * DÉPÔT D'UNE ANNALE — gratuit, comme tout dépôt. Relire le format sur les annales est une
 * détection payante (vision LLM : un crédit et une génération du quota du jour) : elle ne
 * part plus en douce à chaque dépôt. L'étudiant la lance lui-même, son coût affiché avant
 * (indicateur d'usage « format »), et la réponse dit ce qui a été débité.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-annale-"));
const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: tmp,
  AUTH_ENABLED: "0",
  DB_DRIVER: "postgres",
  DATABASE_URL: "pglite://memory",
  AI_BUDGET_MARGIN: "unlimited",
  BILLING_ENABLED: "1",
  SIGNUP_FREE_CREDITS: "10",
  DAILY_GEN_QUOTA: "3",
  DAILY_ASSIST_QUOTA: "unlimited",
  RATE_LIMIT_PER_USER_MIN: "unlimited",
  MAX_ACTIVE_JOBS: "unlimited",
  MAX_GLOBAL_JOBS: "unlimited",
  STORAGE_MIN_FREE_PERCENT: "0",
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

/** Arrêt gracieux simulé : un job lancé reste en file, différé — aucun vrai worker n'est démarré. */
const drainForTests = () => { (globalThis as { __cortexDrain?: unknown }).__cortexDrain = { draining: true, workers: new Map(), handler: null, signals: 0 }; };

before(async () => {
  applyEnv();
  drainForTests();
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  delete (globalThis as { __cortexDrain?: unknown }).__cortexDrain;
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of Object.keys(ENV)) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

function uploadRequest(name: string, text: string): NextRequest {
  const boundary = "----cortexAnnale";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from(text), Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return new NextRequest("http://cortex.test/api/refs/upload?course=ml", {
    method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) }, body,
  });
}

async function account() {
  const credits = await import("../lib/billing/credits");
  const { usedToday } = await import("../lib/billing/guards");
  const { currentUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const user = currentUser();
  const formatJobs = await runWithCourse("ml", async () => {
    await q.ensureTable("jobs");
    return Number((await q.get<{ n: number }>(`SELECT count(*) n FROM jobs WHERE type = 'format'`))?.n ?? 0);
  });
  return { balance: await credits.getBalanceCenti(user), quota: await usedToday("gen", user), formatJobs };
}

test("trois annales déposées : aucun crédit, aucune génération du jour, aucune détection lancée", async () => {
  const { POST } = await import("../app/api/refs/upload/route");
  const start = await account();
  for (const year of [2023, 2024, 2025]) {
    const res = await POST(uploadRequest(`final-${year}.txt`, `Examen final fictif ${year}. Exercice 1 : calculer une intégrale.`));
    assert.equal(res.status, 200, await res.clone().text());
    const d = await res.json();
    assert.deepEqual(d.files, [`final-${year}.txt`]);
    assert.equal(d.formatPending, true, "la réponse propose la relecture du format, sans la lancer");
    assert.equal(d.formatJobId, undefined);
  }
  assert.deepEqual(await account(), start);
});

test("relire le format : lancé à la demande, la réponse dit le crédit débité ; un second clic ne débite rien", async () => {
  const { POST } = await import("../app/api/refs/format/route");
  const start = await account();
  const req = () => new NextRequest("http://cortex.test/api/refs/format?course=ml", { method: "POST" });
  const first = await POST(req());
  assert.equal(first.status, 200, await first.clone().text());
  const d = await first.json();
  assert.equal(typeof d.jobId, "number");
  assert.equal(d.chargedCredits, 1);
  const now = await account();
  assert.equal(start.balance - now.balance, 100);
  assert.equal(now.quota - start.quota, 1);
  assert.equal(now.formatJobs - start.formatJobs, 1);

  const again = await (await POST(req())).json();
  assert.equal(again.jobId, d.jobId, "la détection en cours est réutilisée");
  assert.equal(again.chargedCredits, 0);
  assert.equal((await account()).balance, now.balance);
});
