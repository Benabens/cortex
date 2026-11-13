/**
 * LES SOURCES EXCLUES LE RESTENT SUR UNE BASE SQL_ASCII, EN VRAI POSTGRES — banc HUM-285 du
 * 13/11/2026 : cluster local initialisé en locale C (SQL_ASCII), `substr(text, 1, 400)` y coupait
 * en octets, au milieu d'un « é » ; le pilote rejetait toute la requête, le `catch` rendait
 * « aucune source exclue » et l'archive « Exemple de résumé… rendu poster » donnait ses notions
 * (rewilding, pergélisol). Verrouillé : le début du texte est coupé côté JS, et une base illisible
 * retombe sur les titres seuls.
 *
 * Base réelle requise : CORTEX_TEST_PG_URL (nom contenant « test »), sinon sauté. Base DÉDIÉE.
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
const DB = `cortextest_source_scope_${process.pid}`;
const DB_URL = (() => { try { const u = new URL(BASE_URL); u.pathname = `/${DB}`; return u.toString(); } catch { return ""; } })();
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-source-scope-"));

const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: DATA_DIR, DB_DRIVER: "postgres", DATABASE_URL: DB_URL, MAX_COURSES_CREATED_PER_HOUR: "unlimited",
};
if (ENABLED) Object.assign(process.env, ENV);

async function admin<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(BASE_URL, { max: 1, onnotice: () => {} });
  try { return await fn(sql); } finally { await sql.end(); }
}

before(async () => {
  if (!ENABLED) return;
  delete process.env.CORTEX_USER;
  await admin((sql) => sql.unsafe(`CREATE DATABASE "${DB}" ENCODING 'SQL_ASCII' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`));
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  if (ENABLED) {
    const { closePostgres } = await import("../db/driver-postgres");
    await closePostgres();
    await admin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`));
    for (const k of Object.keys(ENV)) delete process.env[k];
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test("archive et note hors programme exclues même quand un « é » tombe sur le 400e octet (base SQL_ASCII)", { skip }, async () => {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { excludedSourceIds, sourceHeads } = await import("../lib/source-scope");
  const row = buildCourseRow({ name: "Enjeux mondiaux SQL_ASCII", code: "HUM-285", language: "fr", examFormat: { kind: "qcm" } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  const head = "Notes de la séance 8. Hors programme 2026. ";
  // 399 octets avant un « é » : `substr(…, 1, 400)` en octets coupe le caractère en deux.
  const offProgram = `${head}${"x".repeat(399 - Buffer.byteLength(head))}écologie, rewilding par clonage.`;
  const ids = await runWithCourse(row.id, async () => {
    for (const t of ["sources", "items"]) await q.ensureTable(t);
    const add = async (title: string, text: string) => {
      const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", title, `course_pdf/${title}`, null, 1);
      await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", title, text);
      return Number(sid);
    };
    const course = await add("S_ance_5_Cavallaro_D_sinformation.md", `Désinformation générative transnationale. ${"é".repeat(300)}`);
    const note = await add("Notes_s_ance_8.md", offProgram);
    const archive = await add("Archive_2025-26_Exemple_de_r_sum_et_bibliographie_attendu_du_rendu_poster.md", `Rewilding et pergélisol. ${"é".repeat(300)}`);
    return { course, note, archive, excluded: await excludedSourceIds(), heads: await sourceHeads() };
  });
  assert.deepEqual([...ids.excluded].sort((a, b) => a - b), [ids.note, ids.archive].sort((a, b) => a - b));
  assert.ok(ids.heads.every((h) => h.head.length <= 400), "début coupé à 400 caractères");
  assert.ok(ids.heads.find((h) => h.id === ids.note)!.head.startsWith(head), "début lu en entier");
});
