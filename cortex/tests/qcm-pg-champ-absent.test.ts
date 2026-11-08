/**
 * UN CHAMP ABSENT NE FAIT PLUS ÉCHOUER UN EXAMEN ENTIER, EN VRAI POSTGRES — banc moteur du
 * 04/11/2026 (synth-docx) : 14 QCM sur 15 construits et vérifiés, puis « UNDEFINED_VALUE :
 * Undefined values are not allowed » à l'enregistrement : le modèle avait omis `explanation`
 * pour un lot, postgres.js refuse un paramètre undefined (PGlite et SQLite le tolèrent, d'où
 * aucun test rouge). Le job échouait, rien n'était livré. Verrouillé : un QCM sans explication
 * est mal formé (sa clé ne serait pas justifiée) et remplacé ; le pilote Postgres traite
 * undefined comme NULL.
 *
 * Base réelle requise : CORTEX_TEST_PG_URL (nom contenant « test »), sinon sauté. Base DÉDIÉE.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const BASE_URL = process.env.CORTEX_TEST_PG_URL ?? "";
const baseDb = (() => { try { return new URL(BASE_URL).pathname.replace(/^\//, ""); } catch { return ""; } })();
const ENABLED = !!BASE_URL && /test/i.test(baseDb);
const skip = ENABLED ? false : "CORTEX_TEST_PG_URL absente (ou base sans « test » dans son nom)";
const DB = `cortextest_champ_absent_${process.pid}`;
const DB_URL = (() => { try { const u = new URL(BASE_URL); u.pathname = `/${DB}`; return u.toString(); } catch { return ""; } })();
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-champ-absent-"));

const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: DATA_DIR, DB_DRIVER: "postgres", DATABASE_URL: DB_URL, MAX_COURSES_CREATED_PER_HOUR: "unlimited",
  LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "test", LLM_MODEL_OPUS: "claude-sonnet-5", LLM_MAX_RETRIES: "0", QCM_BATCH_CONCURRENCY: "1",
};
if (ENABLED) Object.assign(process.env, ENV);

let designCalls = 0;
function item(q: number, withExplanation: boolean) {
  return {
    topic: "Équité", type: "scq", stem: `Question ${q} : que dit le cours sur l'impact disparate ?`,
    options: ["Une affirmation juste, tirée du cours. (clé)", "Une affirmation inversée par rapport au cours.", "Une affirmation qui change une condition du cours.", "Une affirmation attribuée à la mauvaise étude."],
    correct: [0], misconceptions: ["", "[inversion] x", "[mauvaise condition] x", "[mauvaise attribution] x"],
    ...(withExplanation ? { explanation: "La bonne réponse reprend le cours ; les autres l'inversent ou le déforment." } : {}),
  };
}
function verifyReply(prompt: string): string {
  const blocks = prompt.split(/^(?=Q\d+\.)/m).filter((b) => /^Q\d+\./.test(b));
  return JSON.stringify({ results: blocks.map((b) => {
    const index = Number(/^Q(\d+)\./.exec(b)![1]);
    const key = [...b.matchAll(/^\s+\((\d+)\) (.*)$/gm)].find((m) => /\(clé\)/.test(m[2]));
    return { index, correct: [key ? Number(key[1]) : 0], ok: true, discrimination: 4, name_only: false, issue: "", course_terms: [], off_course: "", off_course_terms: [], off_matter: "", trivial_distractors: [], definition_mismatch: "" };
  }) });
}

let llm: http.Server;

async function admin<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(BASE_URL, { max: 1, onnotice: () => {} });
  try { return await fn(sql); } finally { await sql.end(); }
}

before(async () => {
  if (!ENABLED) return;
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const content = (JSON.parse(body) as { messages: { content: unknown }[] }).messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      let text = "{}";
      if (/"duplicates"/.test(content)) text = JSON.stringify({ notions: [], duplicates: [] });
      else if (/"results"/.test(content)) text = verifyReply(content);
      else if (/"items"/.test(content)) {
        designCalls++;
        const n = Number(/\((\d+) QCM\)/.exec(content)?.[1] ?? 1);
        // Premier lot : le modèle oublie l'explication du second QCM (comme le lot 5 de synth-docx).
        text = JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(designCalls * 10 + i, !(designCalls === 1 && i === 1))) });
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  await admin((sql) => sql.unsafe(`CREATE DATABASE "${DB}"`));
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  if (ENABLED) {
    await new Promise((r) => llm.close(r));
    const { closePostgres } = await import("../db/driver-postgres");
    await closePostgres();
    await admin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`));
    for (const k of [...Object.keys(ENV), "LLM_BASE_URL"]) delete process.env[k];
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test("le pilote Postgres traite un paramètre undefined comme NULL", () => {
  return import("../db/driver-postgres").then(({ pgSafeParams }) => {
    assert.deepEqual(pgSafeParams([undefined, "a", 1, null]), [null, "a", 1, null]);
  });
});

test("un QCM livré sans explication par le modèle est remplacé ; l'examen est livré, en vrai Postgres", { skip }, async () => {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  const row = buildCourseRow({ name: "Équité champ absent", code: "CS-290", language: "fr", examFormat: { kind: "qcm" } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  const r = await runWithCourse(row.id, async () => {
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
    const text = "Impact disparate, taux de faux positifs, équité des modèles.";
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", "Séances", "course_pdf/s1", null, 1);
    const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", "Séances", text);
    await indexItemForSearch(iid, sid, "Séances", text);
    for (const label of ["Équité", "Faux positifs", "Impact disparate", "Modération"]) await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, null, 3, 1);
    const res = await generateQcmExam({ count: 2, openCount: 0 });
    return { res, items: (await getQcmExam(res.id, true))!.items };
  });
  assert.equal(r.res.count, 2);
  for (const it of r.items) assert.ok(it.explanation.trim(), "chaque QCM livré a son explication");
});
