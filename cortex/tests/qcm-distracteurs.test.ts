/**
 * DISTRACTEURS TRIVIAUX : REMPLACÉS, PAS LA QUESTION — banc moteur du 04/11/2026 (CS-290, 15 QCM) :
 * le correcteur relevait au moins un distracteur éliminable sans le cours sur 41 QCM vérifiés sur
 * 50. Chacun faisait régénérer la question entière (énoncé et clé pourtant bons), puis jeter tout
 * item qui en gardait un : 8 QCM livrés sur 15, 36 min, des lots de comblement en série.
 * Verrouillé : un QCM dont le SEUL défaut est un ou des distracteurs triviaux garde son énoncé et
 * sa clé ; seules ces options sont remplacées (avec l'explication), puis revérifiées.
 * Fournisseur LLM simulé : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-distracteurs-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

const ABSURD = "Une option absurde que tout étudiant élimine.";
const NEW_DISTRACTOR = "Une affirmation proche du cours, fausse à une condition près.";

function item(q: number) {
  return {
    topic: "CS-290", type: "scq", stem: `Question ${q} : que dit le cours sur la notion ${q} ?`,
    options: ["Une affirmation juste, tirée du cours. (clé)", "Une affirmation inversée par rapport au cours.", ABSURD, "Une affirmation attribuée à la mauvaise étude."],
    correct: [0], misconceptions: ["", "[inversion] x", "[remplissage] x", "[mauvaise attribution] x"],
    explanation: "La bonne réponse reprend le cours ; l'inversion et la mauvaise attribution le déforment.",
  };
}

let designCalls = 0;
let repairCalls = 0;
let repairPrompts: string[] = [];
/** Ce que le remplacement simulé propose : par défaut un distracteur de qualité. */
let replacement = NEW_DISTRACTOR;

function verifyReply(prompt: string): string {
  const blocks = prompt.split(/^(?=Q\d+\.)/m).filter((b) => /^Q\d+\./.test(b));
  return JSON.stringify({ results: blocks.map((b) => {
    const index = Number(/^Q(\d+)\./.exec(b)![1]);
    const opts = [...b.matchAll(/^\s+\((\d+)\) (.*)$/gm)];
    const key = opts.find((m) => /\(clé\)/.test(m[2]));
    const trivial = opts.filter((m) => m[2].startsWith("Une option absurde")).map((m) => Number(m[1]));
    return { index, correct: [key ? Number(key[1]) : 0], ok: true, discrimination: 4, name_only: false, issue: "", course_terms: [], off_course: "", off_course_terms: [], off_matter: "", trivial_distractors: trivial, definition_mismatch: "" };
  }) });
}

/** Le remplacement simulé : pour chaque option à remplacer, `replacement`. */
function repairReply(prompt: string): string {
  const out = [...prompt.matchAll(/^Q(\d+)\..*?$([\s\S]*?)(?=^Q\d+\.|$(?![\s\S]))/gm)].map((m) => {
    const flagged = [...m[2].matchAll(/^\s+\((\d+)\) .* ← À REMPLACER/gm)].map((x) => Number(x[1]));
    return { index: Number(m[1]), distractors: flagged.map((k) => ({ option: k, text: replacement, misconception: "[mauvaise condition] x" })), explanation: "La bonne réponse reprend le cours ; les autres changent une condition ou l'attribution." };
  });
  return JSON.stringify({ replacements: out });
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
      if (/"replacements"/.test(content)) { repairCalls++; repairPrompts.push(content); text = repairReply(content); }
      else if (/"duplicates"/.test(content)) text = JSON.stringify({ notions: [], duplicates: [] });
      else if (/"results"/.test(content)) text = verifyReply(content);
      else if (/"items"/.test(content)) {
        designCalls++;
        const n = Number(/\((\d+) QCM\)/.exec(content)?.[1] ?? 1);
        text = JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(designCalls * 10 + i)) });
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  process.env.QCM_BATCH_CONCURRENCY = "1";
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => { designCalls = 0; repairCalls = 0; repairPrompts = []; replacement = NEW_DISTRACTOR; });

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL", "MAX_COURSES_CREATED_PER_HOUR", "QCM_BATCH_CONCURRENCY"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

let courseN = 0;
async function course(): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const row = buildCourseRow({ name: `Responsible distracteurs ${++courseN}`, code: "CS-290", language: "fr", examFormat: { kind: "qcm" } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
    const text = "Équité des modèles, taux de faux positifs, impact disparate, modération de contenus.";
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", "Séances", "course_pdf/s1", null, 1);
    const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", "Séances", text);
    await indexItemForSearch(iid, sid, "Séances", text);
    for (const label of ["Équité", "Faux positifs", "Impact disparate", "Modération", "Recommandation", "Biais", "Confusion", "Proxy"]) {
      await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, null, 3, 1);
    }
  });
  return row.id;
}

async function exam(id: string, count: number) {
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  const steps: string[] = [];
  const pcts: { s: string; p: number }[] = [];
  return runWithCourse(id, async () => {
    const r = await generateQcmExam({ count, openCount: 0, onStep: (s, p) => { steps.push(s); pcts.push({ s, p }); } });
    return { r, steps, pcts, items: (await getQcmExam(r.id, true))!.items };
  });
}

test("seul défaut = un distracteur trivial : l'option est remplacée, l'énoncé et la clé gardés, aucune régénération ni comblement", async () => {
  const { r, steps, items } = await exam(await course(), 4);
  assert.equal(r.count, 4, steps.join("\n"));
  assert.equal(designCalls, 1, "aucune question régénérée en entier");
  assert.equal(repairCalls, 1, "un seul appel de remplacement pour le lot");
  assert.ok(!steps.some((s) => /comblement/.test(s)), steps.join("\n"));
  for (const it of items) {
    assert.ok(!it.options.includes(ABSURD), it.options.join(" | "));
    assert.ok(it.options.includes(NEW_DISTRACTOR));
    assert.match(it.stem, /^Question 1\d : /, "énoncé d'origine gardé");
    assert.equal(it.options[(it as { correct?: number[] }).correct![0]], "Une affirmation juste, tirée du cours. (clé)");
  }
  assert.match(repairPrompts[0], /← À REMPLACER/);
  assert.doesNotMatch(repairPrompts[0], /"items"|"results"/, "le prompt de remplacement ne porte pas les marqueurs des autres appels");
});

test("le remplaçant reste trivial à la revérification : aucune question livrée avec lui", async () => {
  replacement = "Une option absurde que tout étudiant élimine encore.";
  // Ici chaque question garde un distracteur trivial : rien n'est livrable, la génération échoue
  // (comme avant ce correctif) plutôt que de livrer ces questions.
  const got = await exam(await course(), 4).catch(() => null);
  for (const it of got?.items ?? []) assert.ok(!it.options.some((o) => o.startsWith("Une option absurde")), it.options.join(" | "));
  assert.equal(repairCalls >= 1, true, "le remplacement a bien été tenté");
});

test("banc du 04/11 : l'avancement bouge dès qu'un lot est conçu, sans attendre sa vérification (8 % pendant 3 à 5 min)", async () => {
  const { pcts } = await exam(await course(), 4);
  const verifying = pcts.find((x) => /Vérification à l'aveugle/.test(x.s));
  assert.ok(verifying && verifying.p > 8, `avancement pendant la première vérification : ${verifying?.p}`);
});
