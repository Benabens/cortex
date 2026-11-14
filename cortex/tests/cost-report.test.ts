/**
 * Rapport de coût : ce que les générations coûtent VRAIMENT (llm_usage), par
 * type de job, face au prix en crédits et au revenu net d'un crédit — pour
 * fixer les prix sur des mesures.
 *
 * Défaut de prod du 14/11/2026 : `DATABASE_URL=<Postgres> npm run cost:report`
 * répondait « aucun job dans llm_usage ». Sans DB_DRIVER, le store global était
 * le SQLite local, vide ; et la voie Postgres aurait exécuté les migrations du
 * store (DDL) sur la base de prod. Le rapport lit maintenant la base désignée
 * par DATABASE_URL, en LECTURE SEULE, sans rien créer.
 *
 * Seams : costReport(reader), et le script scripts/cost-report.ts lancé comme
 * par Ben. Hermétique : SQLite et PGlite jetables.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-costrep-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.CREDIT_NET_USD = "0.5";
process.env.AI_BUDGET_MARGIN = "0.6";
delete process.env.CREDITS_COST_JSON;

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "CREDIT_NET_USD", "AI_BUDGET_MARGIN"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Row = [user: string, course: string, job: string | null, site: string, cost: number, estimated?: number];
const INSERT = `INSERT INTO llm_usage (user_id, course, provider, model, tokens_in, tokens_out, cost_usd, estimated, job_id, call_site, created_at)
  VALUES ($1,$2,'anthropic','claude-sonnet-5',1000,500,$3,$4,$5,$6,'2026-11-14 10:00:00')`;

test("costReport : agrège par job puis par type, et donne le prix minimal en crédits", async () => {
  const { authRun } = await import("../db/auth-store");
  const rows: Row[] = [
    // Deux examens : 1,00 $ (deux appels) et 3,00 $ ; un QCM à 4,00 $ ; deux drills à 0,05 et 0,15 $.
    ["a", "ml", "1", "exam:generateBatch", 0.6],
    ["a", "ml", "1", "exam:verify", 0.4],
    ["b", "ml", "1", "exam:generateBatch", 3.0], // même id, autre compte : autre job
    ["a", "ml", "2", "qcm:generateQcmExam", 4.0],
    ["a", "ml", null, "assist:drill", 0.05],
    ["a", "ml", null, "assist:drill", 0.15, 1],
  ];
  for (const [u, c, j, s, cost, est = 0] of rows) {
    await authRun(INSERT.replace(/\$\d/g, "?"), u, c, cost, est, j, s);
  }

  const { costReport } = await import("../lib/billing/cost-report");
  const r = await costReport();
  assert.equal(r.rows, 6);
  assert.equal(r.totalUsd, 8.2);
  const exam = r.jobs.find((j) => j.type === "exam")!;
  assert.equal(exam.jobs, 2);
  assert.equal(exam.avgUsd, 2);
  assert.equal(exam.maxUsd, 3);
  assert.equal(exam.priceCredits, 2);
  // Statuts inconnus (SQLite) : le coût par job livré est la moyenne.
  assert.equal(exam.perDeliveredUsd, 2);
  assert.equal(exam.minCreditsBreakEven, 4);   // 2 $ ÷ 0,50 $ par crédit
  assert.equal(exam.minCreditsSafe, 6.7);      // 2 $ ÷ (0,6 × 0,50 $), arrondi au dixième supérieur
  const qcm = r.jobs.find((j) => j.type === "qcm")!;
  assert.equal(qcm.jobs, 1);
  assert.equal(qcm.minCreditsBreakEven, 8);
  const drill = r.assist.find((a) => a.callSite === "drill")!;
  assert.equal(drill.calls, 2);
  assert.equal(drill.avgUsd, 0.1);
  assert.equal(drill.maxUsd, 0.15);
  assert.equal(drill.priceCredits, 0.1);
  assert.equal(drill.estimatedCalls, 1);
  assert.equal(drill.minCreditsBreakEven, 0.2);
  assert.match(r.text, /exam/);
  assert.match(r.text, /drill/);

  // Moteur récent seulement : les appels antérieurs à `since` sont écartés.
  const later = await costReport(undefined, process.env, { since: "2026-11-15" });
  assert.equal(later.rows, 0);
  assert.equal(later.jobs.length, 0);
  assert.match(later.text, /depuis le 2026-11-15/);
});

test("script cost:report : DATABASE_URL seul (sans DB_DRIVER) lit cette base, en lecture seule, statuts de jobs compris", async () => {
  const dir = path.join(tmp, "pg");
  // Une base « de prod » minimale : le store global, un tenant et sa table jobs.
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite(dir);
  await db.exec(`CREATE TABLE llm_usage (id serial PRIMARY KEY, user_id text NOT NULL, course text NOT NULL, provider text NOT NULL,
    model text NOT NULL, tokens_in integer, tokens_out integer, cost_usd double precision NOT NULL DEFAULT 0,
    estimated integer NOT NULL DEFAULT 0, job_id text, call_site text, created_at text NOT NULL)`);
  await db.exec(`CREATE TABLE tenants (user_id text NOT NULL, course text NOT NULL, schema_name text NOT NULL, last_seen text NOT NULL)`);
  await db.exec(`CREATE SCHEMA t_u1_ml; CREATE TABLE t_u1_ml.jobs (id serial PRIMARY KEY, type text, status text)`);
  await db.exec(`INSERT INTO tenants VALUES ('u1', 'ml', 't_u1_ml', '2026-11-14 10:00:00')`);
  await db.exec(`INSERT INTO t_u1_ml.jobs (id, type, status) VALUES (1, 'qcm', 'done'), (2, 'qcm', 'error'), (3, 'qcm', 'done')`);
  const seed: Row[] = [
    ["u1", "ml", "1", "qcm:generateBatch", 4.0],
    ["u1", "ml", "1", "qcm:verify", 1.0],
    ["u1", "ml", "2", "qcm:generateBatch", 2.0],  // échoué : payé quand même
    ["u1", "ml", "3", "qcm:generateBatch", 5.0],
  ];
  for (const [u, c, j, s, cost, est = 0] of seed) await db.query(INSERT, [u, c, cost, est, j, s]);
  await db.close();

  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: `pglite://${dir}`, CREDIT_NET_USD: "0.5" };
  delete env.DB_DRIVER;
  const out = execFileSync(path.join(process.cwd(), "node_modules", ".bin", "tsx"), ["scripts/cost-report.ts"], { env, encoding: "utf8" });

  assert.doesNotMatch(out, /aucun job/);
  assert.match(out, /lecture seule/);
  assert.match(out, /4 appels/);
  // 3 QCM, 2 livrés, 1 échoué ; 12 $ au total → 6 $ par QCM livré → 12 crédits au seuil à 0,50 $ le crédit.
  const line = out.split("\n").find((l) => /^qcm\s/.test(l));
  assert.ok(line, out);
  assert.match(line!, /^qcm\s+3\s+2\s+1\s/);
  assert.match(line!, /\s6\s/);
  assert.match(line!, /\s12\s/);

  // Rien n'a été créé ni migré dans la base lue.
  const check = new PGlite(dir);
  const tables = await check.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
  );
  assert.deepEqual(tables.rows.map((t) => t.table_name), ["llm_usage", "tenants"]);
  await check.close();
});
