/**
 * BILAN D'EXPLOITATION EN VRAI POSTGRES — la prod : un schéma par (compte, cours), nommé par
 * public.tenants. Le bilan doit lire les jobs de TOUS les tenants (lecture qualifiée), joindre
 * le registre et l'usage globaux, et ne rien écrire d'autre que sa clé du jour.
 *
 * Base réelle requise : CORTEX_TEST_PG_URL (nom contenant « test »), sinon sauté ;
 * base DÉDIÉE créée puis supprimée.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const BASE_URL = process.env.CORTEX_TEST_PG_URL ?? "";
const baseDb = (() => { try { return new URL(BASE_URL).pathname.replace(/^\//, ""); } catch { return ""; } })();
const ENABLED = !!BASE_URL && /test/i.test(baseDb);
const skip = ENABLED ? false : "CORTEX_TEST_PG_URL absente (ou base sans « test » dans son nom)";
const DB = `cortextest_bilan_${process.pid}`;
const DB_URL = (() => { try { const u = new URL(BASE_URL); u.pathname = `/${DB}`; return u.toString(); } catch { return ""; } })();
const DATA_DIR = ENABLED ? fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bilan-pg-")) : "";
const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: DATA_DIR, DB_DRIVER: "postgres", DATABASE_URL: DB_URL,
  AUTH_ENABLED: "1", BILLING_ENABLED: "1", SIGNUP_FREE_CREDITS: "0",
  OPS_DIGEST_ENABLED: "1", OPS_DIGEST_TO: "proprietaire@exemple.test", CREDIT_NET_USD: "0.64",
  LLM_PROVIDER: "claude-code", CORTEX_CLAUDE_BIN: "/usr/bin/false",
};
if (ENABLED) Object.assign(process.env, ENV);

const ALICE = "alice.fictive@exemple.test";
const BOB = "bob.fictif@exemple.test";
const MONDAY = new Date("2026-11-23T08:30:00Z");
const at = (minAgo: number) => new Date(MONDAY.getTime() - minAgo * 60_000).toISOString().slice(0, 19).replace("T", " ");

async function admin<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(BASE_URL, { max: 1, onnotice: () => {} });
  try { return await fn(sql); } finally { await sql.end(); }
}

async function ownedCourse(id: string, owner: string) {
  const { insertCourse } = await import("../db/courses-store");
  await insertCourse({
    id, owner_user_id: owner, name: `Cours secret ${id}`, short: id.toUpperCase(), code: null, exam_name: "Final", exam_kind: "Final", university: null,
    university_lines: "[]", faculty: null, teachers: "[]", language: "fr", profile_id: null, duration_min: 120, exam_date: null,
    db_file: null, refs_rel: null, exams_rel: null, uploads_rel: null, content_rel: null, created_at: "2026-09-01 00:00:00",
  });
}

async function job(owner: string, course: string, type: string, status: string, endedMinAgo: number, minutes: number, billedCenti: number, costUsd: number, code?: string) {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { authRun } = await import("../db/auth-store");
  const jobs = await import("../lib/jobs");
  const start = at(endedMinAgo + minutes);
  const id = await runWithUser(owner, () => runWithCourse(course, async () => {
    await jobs.ensureJobsSchema();
    return q.insert(
      `INSERT INTO jobs (type, target, status, current_step, progress, error_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      type, null, status, "Étape secrète", 100, code ? JSON.stringify({ code }) : null, start, at(endedMinAgo),
    );
  }));
  const ref = `job:${owner}:${course}:${id}`;
  await runWithUser(owner, () => runWithCourse(course, () => q.run(`UPDATE jobs SET credit_ref = ? WHERE id = ?`, ref, id)));
  if (billedCenti) await authRun(`INSERT INTO credit_transactions (user_id, delta, reason, ref, unit, created_at) VALUES (?,?,?,?,'centi',?)`, owner, -billedCenti, `génération ${type}`, ref, start);
  if (costUsd) await authRun(`INSERT INTO llm_usage (user_id, course, provider, model, cost_usd, job_id, call_site, credit_ref, created_at) VALUES (?,?,?,?,?,?,?,?,?)`, owner, course, "anthropic", "claude-opus-5-5", costUsd, String(id), `${type}:generate`, ref, start);
  return ref;
}

before(async () => {
  if (!ENABLED) return;
  delete process.env.CORTEX_USER;
  await admin((sql) => sql.unsafe(`CREATE DATABASE "${DB}"`));
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  const credits = await import("../lib/billing/credits");
  const { recordUsage } = await import("../lib/billing/usage");
  await ensureCoursesLoaded();
  await ownedCourse("reseaux-fictif", ALICE);
  await ownedCourse("proba-fictif", BOB);
  await reloadCourses();
  await credits.getBalance(ALICE);
  await recordUsage({ provider: "anthropic", model: "claude-opus-5-5", tokensIn: 1, tokensOut: 1 }).catch(() => {});
});

after(async () => {
  if (!ENABLED) return;
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  await admin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test("Postgres : le bilan du lundi lit les jobs de chaque tenant, joint coûts et facturé, n'écrit que sa clé", { skip }, async () => {
  for (let i = 0; i < 3; i++) await job(ALICE, "reseaux-fictif", "qcm", "done", 60 * 24 * (i + 2), 10, 1800, 2);
  await job(BOB, "proba-fictif", "qcm", "error", 60 * 50, 4, 0, 0.5, "llm_provider_unreachable");
  for (let i = 0; i < 2; i++) await job(BOB, "proba-fictif", "drill", "done", 60 * (30 + i), 2, 50, 0.62);
  const { authAll } = await import("../db/auth-store");
  const tenants = await authAll<{ schema_name: string }>(`SELECT schema_name FROM public.tenants`);
  assert.ok(tenants.length >= 2, "un schéma par compte et cours");

  const sent: Array<{ subject: string; text: string }> = [];
  const { runOpsDigest } = await import("../lib/ops-digest");
  const before = await authAll<{ key: string; value: string }>(`SELECT key, value FROM app_meta ORDER BY key`);
  const r = await runOpsDigest({ now: MONDAY, send: async (m) => { sent.push(m); return { ok: true }; } });
  assert.equal(r.status, "sent", JSON.stringify(r));
  const { text } = sent[0];
  assert.match(text, /qcm\s+4 jobs\s+3 livrés\s+1 échec/);
  assert.match(text, /drill\s+2 jobs\s+2 livrés\s+0 échec/);
  assert.match(text, /drill\s.*0,62 \$ moy\..*0,32 \$ facturé\s+−0,30 \$ marge/);
  assert.match(text, /Étudiants touchés par une erreur : 1/);
  for (const s of [ALICE, BOB, "reseaux-fictif", "proba-fictif", "Cours secret", "Étape secrète"]) assert.ok(!JSON.stringify(sent).includes(s), s);
  // Seule écriture : la clé du jour.
  const afterRows = await authAll<{ key: string; value: string }>(`SELECT key, value FROM app_meta ORDER BY key`);
  const added = afterRows.filter((a) => !before.some((b) => b.key === a.key && b.value === a.value)).map((a) => a.key);
  assert.deepEqual(added, ["ops_digest:2026-11-23"]);
});
