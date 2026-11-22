/**
 * FORMAT ROBUSTE (chasse aux bugs du 22/11/2026).
 *  - Les nombres du format lu dans les annales (texte libre du modèle) sont nettoyés : une durée
 *    négative passait le repli « déclarée ou détectée » et donnait des points négatifs ; « 2h »
 *    s'affichait « 2h min » ; « vingt » questions rendait la part de QCM NaN. Appliqué à la lecture,
 *    donc aussi aux profils déjà enregistrés.
 *  - L'ADN des annales (moules) redemande une réponse illisible AVEC l'erreur, et ne relance plus
 *    à l'identique un fournisseur en panne, déjà relancé par la couche LLM.
 * Cours fictifs uniquement.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { cleanProfile } from "../lib/exam-format";
import type { FormatProfile } from "../lib/format";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-format-robuste-"));
Object.assign(process.env, {
  CORTEX_DATA_DIR: tmp, LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "test", LLM_MODEL_OPUS: "claude-sonnet-5",
  LLM_MAX_RETRIES: "0", MAX_COURSES_CREATED_PER_HOUR: "unlimited", MAX_COURSES_PER_USER: "unlimited",
});

const base = (over: Record<string, unknown>): FormatProfile => ({
  format_summary: "QCM", duration_min: 60, total_points: 20, has_mcq: true, scq_vs_mcq_convention: "",
  question_types: [{ type: "scq", approx_count: 10, share_pct: 100, points_each: 2, note: "" }], sections: [], topics_emphasis: [],
  ...over,
} as FormatProfile);

test("cleanProfile : durées écrites en texte lues en minutes, illisibles ou hors bornes = inconnues (0)", () => {
  const d = (v: unknown) => cleanProfile(base({ duration_min: v })).duration_min;
  assert.deepEqual([d(90), d("90"), d("90 min"), d("2h"), d("1h30"), d("2 h 30"), d(-90), d(0), d("deux heures"), d(5000), d(null)], [90, 90, 90, 120, 90, 150, 0, 0, 0, 0, 0]);
});

test("cleanProfile : nombres de questions, parts et barème illisibles = 0, jamais NaN ni négatifs", () => {
  const p = cleanProfile(base({
    total_points: -20,
    question_types: [
      { type: "scq", approx_count: "vingt", share_pct: "40%", points_each: -1 },
      { type: "open", approx_count: "3", share_pct: 60, points_each: "5" },
      null, { approx_count: 2 },
    ],
  }));
  assert.equal(p.total_points, 0);
  assert.deepEqual(p.question_types.map((t) => [t.type, t.approx_count, t.share_pct, t.points_each]), [["scq", 0, 40, 0], ["open", 3, 60, 5]]);
});

// ── Format résolu depuis un profil déjà enregistré ─────────────────────────────────────────────
type Reply = { status?: number; text?: string };
let replies: Reply[] = [];
const prompts: string[] = [];
let llm: http.Server;

before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: { content: unknown }[] };
      prompts.push(parsed.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
      const r = replies.shift() ?? { text: "{}" };
      if (r.status) { res.statusCode = r.status; res.end(JSON.stringify({ error: { message: "panne" } })); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: r.text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => { replies = []; prompts.length = 0; });

after(async () => {
  await new Promise((r) => llm.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
async function course(stored: Record<string, unknown> | null): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const row = buildCourseRow({ name: `Cours fictif format ${++n}`, code: "FIC 102", language: "fr" }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics", "format_profile", "exam_exercises"]) await q.ensureTable(t);
    const fid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "final", "Final 2025", "final/2025", 2025, 1);
    await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, fid, "exercise", "Final 2025", "Examen final. Choisissez la bonne réponse à chaque question.");
    if (stored) await q.run(`INSERT INTO format_profile (json) VALUES (?)`, JSON.stringify({ basis: "annales", ...base(stored) }));
  });
  return row.id;
}

test("profil enregistré à durée négative : durée inconnue, pas -90 min", async () => {
  const { runWithCourse } = await import("../db/client");
  const { resolveExamFormat } = await import("../lib/exam-format");
  const f = await runWithCourse(await course({ duration_min: -90 }), () => resolveExamFormat());
  assert.equal(f.durationMin, null);
});

test("profil enregistré à « 2h » : 120 minutes", async () => {
  const { runWithCourse } = await import("../db/client");
  const { resolveExamFormat } = await import("../lib/exam-format");
  const f = await runWithCourse(await course({ duration_min: "2h" }), () => resolveExamFormat());
  assert.equal(f.durationMin, 120);
});

// ── ADN : classification des moules ────────────────────────────────────────────────────────────
async function classify(replyList: Reply[]) {
  const id = await course(null);
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { classifyMolds, ensureDnaSchema } = await import("../lib/exam-dna");
  return runWithCourse(id, async () => {
    await ensureDnaSchema();
    const ex = await q.insert(`INSERT INTO exam_exercises (topic, statement, exo_type) VALUES (?,?,?)`, "Arbres", "Insérez 7, 3, 9 dans un ABR.", "open");
    replies = replyList.map((r) => ({ ...r, text: r.text?.replace("$ID", String(ex)) }));
    const r = await classifyMolds();
    return { r, calls: prompts.length };
  });
}

test("ADN : réponse illisible redemandée AVEC l'erreur, puis classée", async () => {
  const { r, calls } = await classify([{ text: "désolé, pas de JSON" }, { text: `{"classified":[{"id":$ID,"mold":"formula_computation","figure_kind":""}]}` }]);
  assert.equal(calls, 2);
  assert.match(prompts[1], /ATTENTION/, "la seconde demande dit ce qui n'allait pas");
  assert.equal(r.classified, 1);
});

test("ADN : fournisseur en panne, pas de seconde série de relances à l'identique", async () => {
  const { r, calls } = await classify([{ status: 500 }, { status: 500 }, { status: 500 }]);
  assert.equal(calls, 1, "LLM_MAX_RETRIES=0 : un seul appel, la couche LLM décide des relances");
  assert.equal(r.classified, 0);
});
