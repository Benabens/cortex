/**
 * UNE NOTION = UNE QUESTION (lib/qcm, contrôle de fin d'examen) — examen 4 de HUM-285 (03/11/2026) :
 * Q7 et Q16 testaient l'avantage à long terme du leadership, Q2/Q11/Q19 les objectifs du même jeu
 * de rôle sur la désinformation, Q12 et Q20 les terres rares, Q8 et Q14 le DSA. Le contrôle de
 * la PR #55 ne retirait que deux questions sur « la même notion ET le même fait ». Verrouillé :
 *  - quand le cours a au moins autant de notions que l'examen a de questions, une notion n'a
 *    qu'une question, quel que soit l'angle ; les suivantes sont retirées et remplacées ;
 *  - un remplacement qui retombe sur une notion déjà posée est retiré à son tour ;
 *  - plus de questions que de notions (ou un accent demandé par l'étudiant) : plusieurs questions
 *    sur une notion restent permises, sous des angles vraiment distincts.
 * Les énoncés sont reconstitués (notions et numéros de l'examen 4) : le modèle simulé lit la notion
 * et l'angle dans l'énoncé. Fournisseur LLM simulé : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-doublons-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

/** Examen 4 : les groupes de questions sur une même notion (numéros 1-based de l'examen). */
const EXAM4: Record<number, string> = {
  2: "objectifs du jeu de rôle sur la désinformation", 11: "objectifs du jeu de rôle sur la désinformation", 19: "objectifs du jeu de rôle sur la désinformation",
  7: "avantage à long terme du leadership", 16: "avantage à long terme du leadership",
  12: "terres rares", 20: "terres rares",
  8: "Digital Services Act (DSA)", 14: "Digital Services Act (DSA)",
};
const notionOf = (n: number) => EXAM4[n] ?? `notion distincte ${n}`;

function item(stem: string) {
  const options = [
    "Une affirmation juste, tirée du cours. (clé)",
    "Une affirmation inversée par rapport au cours.",
    "Une affirmation qui change une condition du cours.",
    "Une affirmation attribuée à la mauvaise étude du cours.",
  ];
  return { topic: "HUM-285", type: "scq", stem, options, correct: [0], misconceptions: ["", "[inversion] x", "[mauvaise condition] x", "[mauvaise attribution] x"], explanation: "La bonne réponse reprend le cours ; les autres l'inversent ou le déforment." };
}

/** Lots initiaux : la question n de l'examen porte la notion de l'examen 4 ; les lots suivants, des notions neuves. */
let design: (n: number, call: number) => ReturnType<typeof item>[] = (n, call) => Array.from({ length: n }, (_, i) => {
  const q = (call - 1) * 4 + i + 1;
  return call <= 5 ? item(`Question ${q} [notion:${notionOf(q)}] [angle:fait ${q}] : que dit le cours ?`) : item(`Remplacement ${call}.${i} [notion:neuve ${call}.${i}] [angle:a] : que dit le cours ?`);
});
let designCalls = 0;
const designPrompts: string[] = [];
const dedupePrompts: string[] = [];

/** Le contrôle de fin d'examen simulé : il lit la notion et l'angle de chaque question dans son énoncé. */
function dedupeReply(prompt: string): string {
  const lines = [...prompt.matchAll(/^Q(\d+)\. .*?\[notion:([^\]]+)\] \[angle:([^\]]*)\]/gm)];
  return JSON.stringify({ notions: lines.map((m) => ({ index: Number(m[1]), notion: m[2], angle: m[3] })), duplicates: [] });
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
before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: { content: unknown }[] };
      const content = parsed.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      let text = "{}";
      if (/"duplicates"/.test(content)) { dedupePrompts.push(content); text = dedupeReply(content); }
      else if (/"results"/.test(content)) text = verifyReply(content);
      else if (/"items"/.test(content)) {
        designCalls++;
        designPrompts.push(content);
        text = JSON.stringify({ items: design(Number(/\((\d+) QCM\)/.exec(content)?.[1] ?? 1), designCalls) });
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  // Lots menés un par un : l'ordre des questions dans l'examen suit celui des lots.
  process.env.QCM_BATCH_CONCURRENCY = "1";
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

const defaultDesign = design;
beforeEach(() => { designCalls = 0; designPrompts.length = 0; dedupePrompts.length = 0; design = defaultDesign; });

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL", "MAX_COURSES_CREATED_PER_HOUR", "QCM_BATCH_CONCURRENCY"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Libellés de notions sans racine commune (variants() les rapprocherait sinon). */
const LABELS = ["Ancrage", "Bulles filtrantes", "Cadrage", "Désinformation", "Externalités", "Fact-checking", "Gouvernance", "Heuristiques", "Inclusion", "Jeux de rôle", "Kahneman", "Leadership", "Monopoles", "Nudges", "Open source", "Plateformes", "Quotas", "Régulation", "Souveraineté", "Tirage au sort", "Utilitarisme", "Vote", "Wikipédia", "Xénophobie", "Algorithmes", "Biométrie", "Cybersécurité", "Données personnelles", "Éthique", "Fracture numérique"];

let courseN = 0;
/** Un cours à `notions` notions (assez pour l'examen, ou moins). */
async function course(notions: number, supports = 1): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const row = buildCourseRow({ name: `Enjeux mondiaux doublons ${++courseN}`, code: "HUM-285", language: "fr", examFormat: { kind: "qcm" } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
    const text = "Leadership et avantage à long terme, objectifs du jeu de rôle sur la désinformation, terres rares et Digital Services Act (DSA).";
    for (let k = 1; k <= supports; k++) {
      const title = supports === 1 ? "Séances 1 à 6" : `Support ${k}`;
      const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", title, `course_pdf/s${k}`, null, 1);
      const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", title, text);
      await indexItemForSearch(iid, sid, title, text);
    }
    for (let k = 1; k <= notions; k++) await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, LABELS[k - 1], null, 3, 1);
  });
  return row.id;
}

async function exam(id: string, count: number, focus?: string) {
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  const steps: string[] = [];
  return runWithCourse(id, async () => {
    const r = await generateQcmExam({ count, openCount: 0, focus, onStep: (s) => { steps.push(s); } });
    return { r, steps, stems: (await getQcmExam(r.id))!.items.map((x) => x.stem) };
  });
}

const notionIn = (stem: string) => /\[notion:([^\]]+)\]/.exec(stem)?.[1] ?? "";

test("HUM-285 examen 4 : une seule question sur le leadership à long terme, le jeu de rôle désinformation, les terres rares et le DSA", async () => {
  const id = await course(30);
  const { r, steps, stems } = await exam(id, 20);
  assert.equal(r.count, 20);
  const notions = stems.map(notionIn);
  assert.equal(new Set(notions).size, 20, `chaque notion une seule fois :\n${notions.join("\n")}`);
  for (const q of [2, 7, 8, 12]) assert.ok(stems.some((s) => s.startsWith(`Question ${q} `)), `Q${q} (première de son groupe) est gardée`);
  for (const q of [11, 14, 16, 19, 20]) assert.ok(!stems.some((s) => s.startsWith(`Question ${q} `)), `Q${q} est retirée`);
  assert.equal(stems.filter((s) => s.startsWith("Remplacement")).length, 5);
  assert.match(dedupePrompts[0], /une notion = une question/i, "le contrôle reçoit le critère strict");
  assert.ok(steps.some((s) => /5 QCM en doublon/.test(s)), steps.filter((s) => /doublon/.test(s)).join("\n"));
  assert.match(designPrompts[designPrompts.length - 1], /objectifs du jeu de rôle sur la désinformation/, "le lot de remplacement sait quelles notions sont déjà posées");
});

test("un remplacement qui retombe sur une notion déjà posée est retiré à son tour", async () => {
  const id = await course(30);
  // Le 1ᵉʳ lot de remplacement repose encore une question sur les terres rares (déjà Q12).
  design = (n, call) => (call === 6 ? Array.from({ length: n }, (_, i) => item(i === 0 ? `Remplacement 6.0 [notion:terres rares] [angle:autre] : que dit le cours ?` : `Remplacement 6.${i} [notion:neuve 6.${i}] [angle:a] : que dit le cours ?`)) : defaultDesign(n, call));
  const { r, stems } = await exam(id, 20);
  assert.equal(r.count, 20);
  assert.equal(new Set(stems.map(notionIn)).size, 20, stems.map(notionIn).join("\n"));
  assert.ok(!stems.some((s) => s.startsWith("Remplacement 6.0")));
  assert.ok(dedupePrompts.length >= 2, "le contrôle repasse après le remplacement");
});

test("plus de questions que de notions : deux questions sur une notion restent, si leurs angles diffèrent", async () => {
  const id = await course(3);
  // 6 questions, 3 notions : Q1/Q4 même notion, angles différents ; Q2/Q5 même notion, MÊME angle.
  design = (n, call) => Array.from({ length: n }, (_, i) => {
    const q = (call - 1) * 4 + i + 1;
    const tags: Record<number, string> = { 1: "[notion:nudge] [angle:définition]", 4: "[notion:nudge] [angle:exemple de la cafétéria]", 2: "[notion:biais] [angle:Svenson]", 5: "[notion:biais] [angle:Svenson]", 3: "[notion:souveraineté] [angle:résidence]", 6: "[notion:souveraineté] [angle:extraterritorialité]" };
    return item(call <= 2 ? `Question ${q} ${tags[q]} : que dit le cours ?` : `Remplacement ${call}.${i} [notion:biais] [angle:ancrage ${call}.${i}] : que dit le cours ?`);
  });
  const { r, stems } = await exam(id, 6);
  assert.equal(r.count, 6);
  assert.ok(stems.some((s) => s.startsWith("Question 1 ")) && stems.some((s) => s.startsWith("Question 4 ")), "angles distincts : les deux gardées");
  assert.ok(!stems.some((s) => s.startsWith("Question 5 ")), "même angle : la seconde retirée");
  assert.ok(stems.some((s) => s.startsWith("Question 3 ")) && stems.some((s) => s.startsWith("Question 6 ")), "souveraineté : deux angles distincts, gardées");
  assert.doesNotMatch(dedupePrompts[0], /une notion = une question/i);
  const last = designPrompts[designPrompts.length - 1];
  assert.match(last, /angle vraiment distinct/, "plus de questions que de notions : le remplacement peut reprendre une notion sous un autre angle");
  assert.doesNotMatch(last, /n'en reprends AUCUNE/);
});

test("accent demandé par l'étudiant : ses questions partagent un thème sans être retirées, les autres restent une notion = une question", async () => {
  const id = await course(30);
  // Q1 et Q2 : les deux questions de l'accent (nudges). Q4 : une question hors accent sur le nudge
  // (doublon d'une question de l'accent) ; Q5 et Q6 : même notion entre elles, hors accent.
  design = (n, call) => Array.from({ length: n }, (_, i) => {
    const q = (call - 1) * 4 + i + 1;
    const tag = q <= 2 ? `[notion:nudge] [angle:facette ${q}]` : q === 4 ? `[notion:nudge] [angle:facette 4]` : q === 6 ? `[notion:autre 5] [angle:b]` : `[notion:autre ${q}] [angle:a]`;
    return item(call <= 2 ? `Question ${q} ${tag} : que dit le cours ?` : `Remplacement ${call}.${i} [notion:neuve ${call}.${i}] [angle:a] : que dit le cours ?`);
  });
  const { r, stems } = await exam(id, 6, "les nudges");
  assert.equal(r.count, 6);
  assert.ok(stems.some((s) => s.startsWith("Question 1 ")) && stems.some((s) => s.startsWith("Question 2 ")), "l'accent garde ses deux questions");
  assert.ok(!stems.some((s) => s.startsWith("Question 4 ")), "une 3ᵉ question sur le nudge, hors accent, est retirée");
  assert.ok(!stems.some((s) => s.startsWith("Question 6 ")), "hors accent, une notion = une question, quel que soit l'angle");
  assert.match(dedupePrompts[0], /une notion = une question/i);
});

test("le dernier lot de remplacement est contrôlé lui aussi : une notion déjà posée n'y reste pas", async () => {
  const id = await course(30);
  // Chaque lot de remplacement repose une question sur les terres rares (déjà Q12).
  design = (n, call) => (call >= 6 ? Array.from({ length: n }, (_, i) => item(i === 0 ? `Remplacement ${call}.0 [notion:terres rares] [angle:encore ${call}] : que dit le cours ?` : `Remplacement ${call}.${i} [notion:neuve ${call}.${i}] [angle:a] : que dit le cours ?`)) : defaultDesign(n, call));
  const { stems } = await exam(id, 20);
  const notions = stems.map(notionIn);
  assert.equal(new Set(notions).size, notions.length, `aucune notion deux fois :\n${notions.join("\n")}`);
  assert.equal(notions.filter((n) => n === "terres rares").length, 1);
});

test("titres de supports ajoutés faute de notions : ils ne comptent pas comme notions pour décider du mode strict", async () => {
  const id = await course(3, 30);
  design = (n, call) => Array.from({ length: n }, (_, i) => {
    const q = (call - 1) * 4 + i + 1;
    return item(call <= 2 ? `Question ${q} [notion:${q % 3}] [angle:fait ${q}] : que dit le cours ?` : `Remplacement ${call}.${i} [notion:0] [angle:autre ${call}.${i}] : que dit le cours ?`);
  });
  await exam(id, 6);
  assert.doesNotMatch(dedupePrompts[0], /une notion = une question/i, "3 notions pour 6 questions : plusieurs questions par notion, sous des angles distincts");
});

test("plus de questions que de notions, angle non nommé par le modèle : pas de retrait sur la seule notion", async () => {
  const id = await course(3);
  design = (n, call) => Array.from({ length: n }, (_, i) => {
    const q = (call - 1) * 4 + i + 1;
    return item(`Question ${q} [notion:${q === 1 || q === 4 ? "nudge" : `autre ${q}`}] [angle:] : que dit le cours ?`);
  });
  const { stems } = await exam(id, 6);
  assert.ok(stems.some((s) => s.startsWith("Question 1 ")) && stems.some((s) => s.startsWith("Question 4 ")));
});
