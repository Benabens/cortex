/**
 * FORME DES RÉPONSES D'UN EXAMEN QCM — suites du banc HUM-285 et de l'examen 3 de prod (02/11/2026).
 *  - Réponse unique : 7 questions sur 19 à réponses multiples dans un examen à réponse unique.
 *    Le générateur suit le mode du format strictement : en réponse unique, une question à
 *    plusieurs clés n'entre jamais dans l'examen (son sujet est comblé).
 *  - Explications : la Q12 de l'examen 3 renvoyait à « la première option » après le mélange
 *    des options, qui l'avait déplacée. Une explication qui désigne une option par sa position
 *    ou sa lettre est régénérée ; elle n'entre jamais dans un examen.
 * Fournisseur LLM simulé : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-reponses-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

type Raw = { topic: string; type: string; stem: string; options: string[]; correct: number[]; misconceptions: string[]; explanation: string };

/** Une question sur les nudges ; `keys` = indices des bonnes options (marquées « (clé) » pour le faux juge). */
function item(n: number, keys = [0], explanation?: string): Raw {
  const options = [
    "Un nudge oriente un choix sans interdire aucune option ni en changer le coût.",
    "Un nudge interdit les options jugées nuisibles pour la personne qui choisit.",
    "Un nudge change le coût des options par une taxe ou une subvention ciblée.",
    "Un nudge impose l'option par défaut sans possibilité de s'en écarter.",
  ].map((o, i) => (keys.includes(i) ? `${o} (clé)` : o));
  return {
    topic: "Nudges numériques",
    type: keys.length > 1 ? "mcq" : "scq",
    stem: `Selon le cours, qu'est-ce qui distingue un nudge d'une obligation ? (q${n})`,
    options,
    correct: keys,
    misconceptions: options.map((_, i) => (keys.includes(i) ? "" : "[quasi-synonyme] confond nudge et contrainte")),
    explanation: explanation ?? "Un nudge préserve la liberté de choix : il ne supprime aucune option et n'en change pas le coût, contrairement à une interdiction ou une taxe.",
  };
}

let design: (n: number, call: number, prompt: string) => Raw[] = (n, call) => Array.from({ length: n }, (_, i) => item(call * 10 + i));
let designCalls = 0;
const designPrompts: string[] = [];

function verifyReply(prompt: string): string {
  const blocks = prompt.split(/^(?=Q\d+\.)/m).filter((b) => /^Q\d+\./.test(b));
  const results = blocks.map((b) => {
    const index = Number(/^Q(\d+)\./.exec(b)![1]);
    const correct = [...b.matchAll(/^\s+\((\d+)\) (.*)$/gm)].filter((m) => /\(clé\)/.test(m[2])).map((m) => Number(m[1]));
    return { index, correct, ok: true, discrimination: 4, name_only: false, issue: "", course_terms: [], off_course: "", off_course_terms: [], off_matter: "" };
  });
  return JSON.stringify({ results });
}

let llm: http.Server;
before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: { content: unknown }[] };
      const content = parsed.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      let text = "{}";
      if (/"results"/.test(content)) text = verifyReply(content);
      else if (/"items"/.test(content)) {
        designCalls++;
        designPrompts.push(content);
        text = JSON.stringify({ items: design(Number(/\((\d+) QCM\)/.exec(content)?.[1] ?? 1), designCalls, content) });
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => {
  designCalls = 0;
  designPrompts.length = 0;
  design = (n, call) => Array.from({ length: n }, (_, i) => item(call * 10 + i));
});

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL", "MAX_COURSES_CREATED_PER_HOUR"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

let courseN = 0;
async function course(examFormat: Record<string, unknown>): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const row = buildCourseRow({ name: `Enjeux mondiaux réponses ${++courseN}`, code: "HUM-285", language: "fr", examFormat }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
    const text = "Nudges numériques : un nudge est une incitation indirecte qui oriente un choix sans interdire aucune option ni en changer le coût (Thaler et Sunstein).";
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", "Nudges", "course_pdf/nudges", null, 1);
    const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", "Nudges", text);
    await indexItemForSearch(iid, sid, "Nudges", text);
    for (const label of ["Nudges numériques", "Architecture du choix", "Paternalisme libéral"]) {
      await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, null, 3, 1);
    }
  });
  return row.id;
}

async function exam(id: string, count: number) {
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  return runWithCourse(id, async () => {
    const r = await generateQcmExam({ count, openCount: 0 });
    return { r, view: (await getQcmExam(r.id, true))! };
  });
}

test("réponse unique (défaut d'un QCM déclaré) : consigne explicite, et une question à deux clés n'entre jamais dans l'examen", async () => {
  const id = await course({ kind: "qcm", questionCount: 4 });
  // Premier lot : une question à deux clés, une « mcq » à une seule clé ; ensuite des questions propres.
  design = (n, call) => Array.from({ length: n }, (_, i) => (call === 1 && i === 0 ? item(i, [0, 2]) : call === 1 && i === 1 ? { ...item(i), type: "mcq" } : item(call * 10 + i)));
  const { r, view } = await exam(id, 4);
  assert.equal(r.count, 4, "le sujet de la question écartée est comblé");
  for (const it of view.items) {
    assert.equal(it.type, "scq", it.stem);
    assert.equal((it as unknown as { correct: number[] }).correct.length, 1, it.stem);
  }
  assert.ok(!view.items.some((it) => /\(q0\)/.test(it.stem)), "la question à deux clés est écartée");
  assert.ok(view.items.some((it) => /\(q1\)/.test(it.stem)), "une question « mcq » à une seule clé est gardée, en réponse unique");
  assert.match(designPrompts[0], /RÉPONSE UNIQUE/);
  assert.doesNotMatch(designPrompts[0], /fais varier le nombre de bonnes réponses/);
});

test("réponses multiples déclarées : toutes les questions sont à choix multiple, et la consigne le dit", async () => {
  const id = await course({ kind: "qcm", questionCount: 3, answerMode: "multiple" });
  design = (n, call) => Array.from({ length: n }, (_, i) => item(call * 10 + i, i % 2 ? [0, 2] : [0]));
  const { r, view } = await exam(id, 3);
  assert.equal(r.count, 3);
  for (const it of view.items) assert.equal(it.type, "mcq", it.stem);
  assert.match(designPrompts[0], /RÉPONSES MULTIPLES/);
  assert.match(designPrompts[0], /fais varier le nombre de bonnes réponses/);
});

/** Explication de la Q12 de l'examen 3 (02/11) : elle désigne les options par leur rang, que le mélange change. */
const Q12 = "La première option est la bonne : le cours définit le nudge comme une incitation indirecte. La deuxième confond nudge et interdiction, la troisième décrit une taxe.";

test("une explication qui désigne une option par sa position ou sa lettre est repérée, pas une tournure du cours", async () => {
  const { citesOptionLabel } = await import("../lib/qcm");
  for (const t of [Q12, "La deuxième option inverse le résultat.", "Les deux premières propositions sont fausses.", "La dernière réponse sur-généralise.", "L'option n°2 confond les deux.", "The first option is correct.", "The last answer reverses the effect.", "Options two and four are wrong.", "La troisième est fausse : elle attribue l'étude à Thaler.",
    "Le second énoncé confond les deux notions.", "Les deux dernières sont fausses.", "La 2e option inverse le résultat.", "La première des options est la bonne.", "La sixième proposition exagère l'effet.", "The 2nd option is wrong.", "The third confuses the two notions.",
    "La bonne réponse est la troisième.", "La première, qui inverse le résultat, est fausse.", "The first and third options are wrong.", "The correct answer is the second."]) {
    assert.equal(citesOptionLabel(t), true, t);
  }
  for (const t of ["La première étude de Vosoughi porte sur Twitter.", "Le premier biais du cours est l'ancrage.", "La deuxième vague de régulation vise les plateformes.", "First-mover advantage explains the market share.", "A nudge preserves freedom of choice.", "L'option d'interdire supprime la liberté de choix.", "Le dernier rapport de l'OCDE le confirme.",
    // Tournures du cours (HUM-285, Système 1) : relevées par la revue, ce ne sont pas des renvois à une option.
    "Le premier est l'ancrage, le second la disponibilité.", "La première est celle de Svenson (1981).", "La dernière correspond à la phase de vérification.", "La première réponse qui vient à l'esprit relève du Système 1.", "The choices one makes depend on the default.", "This answers one of the key questions.", "The first is anchoring, the second availability.",
    "Le premier affirme que les incitations comptent (Becker).", "La première proposition de Thaler porte sur l'épargne.", "It is the answer one would expect."]) {
    assert.equal(citesOptionLabel(t), false, t);
  }
});

test("Q12 de l'examen 3 : une explication par position est régénérée et n'entre jamais dans l'examen", async () => {
  const id = await course({ kind: "qcm", questionCount: 4 });
  design = (n, call) => Array.from({ length: n }, (_, i) => (call === 1 && i === 2 ? item(2, [0], Q12) : item(call * 10 + i)));
  const { r, view } = await exam(id, 4);
  assert.equal(r.count, 4);
  for (const it of view.items) assert.doesNotMatch(it.explanation, /première option|deuxième|troisième/, it.stem);
  assert.ok(designPrompts.slice(1).some((p) => /position|lettre/.test(p) && /\(q2\)/.test(p)), "la régénération dit pourquoi la question est refaite");
});

test("examen déjà en base : une explication par position (options mélangées depuis) n'est plus montrée", async () => {
  const id = await course({ kind: "qcm", questionCount: 1 });
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { getQcmExam, gradeQcm } = await import("../lib/qcm");
  await runWithCourse(id, async () => {
    for (const t of ["exams", "qcm_items"]) await q.ensureTable(t);
    const examId = await q.insert(`INSERT INTO exams (format_template, status) VALUES ('qcm','ready')`);
    const it = item(3, [2]);
    await q.run(`INSERT INTO qcm_items (exam_id, idx, topic, type, stem, options_json, correct_json, misconceptions_json, explanation, verified) VALUES (?,?,?,?,?,?,?,?,?,?)`, examId, 0, it.topic, "scq", it.stem, JSON.stringify(it.options), "[2]", JSON.stringify(it.misconceptions), Q12, 1);
    const view = (await getQcmExam(examId, true))!;
    assert.doesNotMatch(view.items[0].explanation, /première option/);
    assert.match(view.items[0].explanation, /position/);
    const graded = await gradeQcm(examId, { 0: [2] });
    assert.doesNotMatch(graded.detail[0].explanation, /première option/);
  });
});

test("mode déclaré contraire aux sources : la consigne de l'examen ne reprend pas la convention des sources", async () => {
  const id = await course({ kind: "qcm", questionCount: 2, answerMode: "multiple" });
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  await runWithCourse(id, async () => {
    await q.ensureTable("format_profile");
    await q.run(`INSERT INTO format_profile (json) VALUES (?)`, JSON.stringify({
      basis: "course_info", exam_kind: "qcm", answer_mode: "single", format_summary: "QCM, une seule réponse correcte", has_mcq: true, duration_min: 0, total_points: 0,
      scq_vs_mcq_convention: "une seule réponse correcte", question_types: [{ type: "scq", approx_count: 0, share_pct: 100, points_each: 1, note: "" }],
      sections: [], topics_emphasis: [], evidence: ["Une seule réponse correcte"], examples: [],
    }));
  });
  design = (n, call) => Array.from({ length: n }, (_, i) => item(call * 10 + i, [0, 2]));
  const { view } = await exam(id, 2);
  for (const it of view.items) assert.equal(it.type, "mcq");
  assert.match(designPrompts[0], /RÉPONSES MULTIPLES/);
  assert.doesNotMatch(designPrompts[0], /une seule réponse correcte/);
});
