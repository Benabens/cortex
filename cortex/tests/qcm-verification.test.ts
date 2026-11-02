/**
 * CLÉ CONTESTÉE À LA VÉRIFICATION — cas de prod du 02/11 (HUM-285, examen 2) :
 * le correcteur à l'aveugle trouvait une autre réponse que la clé (Q19 :
 * alignement externe au lieu d'interne) ; le moteur remplaçait la clé et
 * ajoutait « [clé corrigée à la vérif : …] » à l'explication, qui concluait
 * toujours l'ancienne réponse. L'étudiant lisait une clé et une explication
 * contradictoires, plus une note interne.
 * Verrouillé, avec un faux modèle (aucune dépense) :
 *  - un item dont la clé est contestée est régénéré, jamais gardé avec son explication ;
 *  - toujours contesté après régénération : écarté, et son sujet comblé ;
 *  - aucune note interne de vérification dans une explication, y compris d'un examen déjà en base.
 * Et, même examen : ~6 questions portaient sur la grille d'évaluation de l'essai (D1/D2/D3),
 * la question ouverte finale ou la mise en forme de la bibliographie du poster. Une question
 * sur les modalités d'examen ou la forme d'un rendu, plutôt que sur la matière, est rejetée.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-cle-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";

/** Un QCM dont la clé conçue est `options[key]`, et dont l'explication défend cette option. */
function item(stem: string, options: string[], key = 0) {
  return {
    topic: "alignement",
    type: "scq",
    stem,
    options,
    correct: [key],
    misconceptions: options.map((_, i) => (i === key ? "" : "[quasi-synonyme] confond deux formes d'alignement")),
    explanation: `La bonne réponse est « ${options[key]} » : c'est la définition du cours.`,
  };
}

const ALIGN = [
  "L'alignement interne relie les objectifs d'un système à ce que veulent ses concepteurs.",
  "L'alignement externe relie les objectifs d'un système aux valeurs de la société.",
  "L'alignement interne relie les objectifs d'un système aux valeurs de la société.",
  "L'alignement externe relie les objectifs d'un système à ce que veulent ses concepteurs.",
];
/** Q19 : la conception défend la 1ʳᵉ option, le correcteur trouve la 2ᵉ. */
const contested = (v: number) => item(`Que désigne l'alignement interne ? (v${v})`, ALIGN, 0);
const plain = (i: number) => item(`Quel énoncé décrit la souveraineté des données ? (n${i})`, [
  "Un État contrôle les données produites sur son territoire, quel que soit l'hébergeur.",
  "Un hébergeur contrôle les données qu'il stocke, quel que soit le pays de production.",
  "Un utilisateur contrôle ses données une fois qu'elles sont publiées sur un réseau.",
  "Une entreprise contrôle les données de ses clients dès qu'elle les a collectées.",
]);

let design: (n: number, call: number, prompt: string) => string = (n, call) => JSON.stringify({ items: Array.from({ length: n }, (_, i) => plain(call * 10 + i)) });
let designCalls = 0;
const designPrompts: string[] = [];
const verifyPrompts: string[] = [];
/** Ce que le juge répond pour une question : la réponse qu'il trouve (texte de l'option), ok, issue. */
const EXTERNAL = /^L'alignement externe relie les objectifs d'un système aux valeurs/;
let judge: (block: string) => { answer: RegExp; ok?: boolean; issue?: string; offMatter?: string; nameOnly?: boolean } = (b) => (
  !/alignement/.test(b) ? { answer: /^Un État contrôle/ }
    : /\(v\d+\)/.test(b) ? { answer: EXTERNAL, issue: "la clé devrait être l'alignement externe" } : { answer: EXTERNAL }
);
function verifyReply(prompt: string): string {
  const blocks = prompt.split(/^(?=Q\d+\.)/m).filter((b) => /^Q\d+\./.test(b));
  const results = blocks.map((b) => {
    const i = Number(/^Q(\d+)\./.exec(b)![1]);
    const j = judge(b);
    const opt = [...b.matchAll(/^\s+\((\d+)\) (.*)$/gm)].find((m) => j.answer.test(m[2]));
    const correct = [opt ? Number(opt[1]) : 0];
    return { index: i, correct, ok: j.ok ?? !j.issue, discrimination: j.nameOnly ? 2 : 4, name_only: !!j.nameOnly, issue: j.issue ?? "", course_terms: [], off_course: "", off_matter: j.offMatter ?? "" };
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
      const content = parsed.messages.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
      let text = "{}";
      if (/"results"/.test(content)) { verifyPrompts.push(content); text = verifyReply(content); }
      else if (/"items"/.test(content)) {
        designCalls++;
        designPrompts.push(content);
        text = design(Number(/\((\d+) QCM\)/.exec(content)?.[1] ?? 1), designCalls, content);
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

beforeEach(() => { designCalls = 0; designPrompts.length = 0; verifyPrompts.length = 0; });

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
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
  const row = buildCourseRow({ name: `Enjeux mondiaux ${++courseN}`, code: "HUM-285", language: "fr", examFormat: { kind: "qcm", questionCount: 20 } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
    const text = "Alignement interne : les objectifs du système suivent ce que veulent ses concepteurs. Alignement externe : ils suivent les valeurs de la société. Souveraineté des données : un État contrôle les données produites sur son territoire.";
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", "Sécurité IA", "course_pdf/securite", null, 1);
    const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", "Sécurité IA", text);
    await indexItemForSearch(iid, sid, "Sécurité IA", text);
    for (const label of ["Alignement interne et externe", "Souveraineté des données", "Gouvernance de l'IA"]) {
      await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, null, 3, 1);
    }
  });
  return row.id;
}

/** L'explication de chaque item défend l'option que porte sa clé, et ne contient aucune note interne. */
function assertCoherent(items: { stem: string; options: string[]; correct?: number[]; explanation: string }[]) {
  for (const it of items) {
    assert.doesNotMatch(it.explanation, /\[clé (?:corrigée|alignée)/, `note interne dans « ${it.stem} »`);
    const key = it.options[(it.correct ?? [])[0]];
    assert.ok(it.explanation.includes(key), `« ${it.stem} » : la clé (« ${key} ») n'est pas l'option que défend l'explication (${it.explanation})`);
  }
}

test("clé contestée par le correcteur : l'item est régénéré, jamais gardé avec son explication d'origine", async () => {
  const id = await course();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  // 1ᵉʳ lot : la Q19 contestée en tête ; régénération : une version que le correcteur confirme.
  design = (n, call, prompt) => {
    if (call === 1) return JSON.stringify({ items: [contested(1), ...Array.from({ length: n - 1 }, (_, i) => plain(i))] });
    if (/À CORRIGER/.test(prompt)) return JSON.stringify({ items: [item("Que désigne l'alignement externe ? (r2)", ALIGN, 1)] });
    return JSON.stringify({ items: Array.from({ length: n }, (_, i) => plain(call * 10 + i)) });
  };
  const r = await runWithCourse(id, () => generateQcmExam({ count: 3, openCount: 0 }));
  assert.equal(r.count, 3);
  const exam = await runWithCourse(id, () => getQcmExam(r.id, true));
  assert.ok(exam!.items.every((it) => !/\(v1\)/.test(it.stem)), "la version contestée n'est pas gardée");
  assert.ok(exam!.items.some((it) => /\(r2\)/.test(it.stem)), "la version régénérée la remplace");
  assertCoherent(exam!.items);
  const regen = designPrompts.find((p) => /À CORRIGER/.test(p));
  assert.match(regen ?? "", /alignement externe/, "la régénération dit ce que le correcteur a trouvé");
});

test("toujours contestée après régénération : la question est écartée et son sujet comblé", async () => {
  const id = await course();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  // La conception défend toujours l'alignement interne pour ce sujet (v1, v2…), le correcteur jamais.
  design = (n, call, prompt) => {
    if (call === 1) return JSON.stringify({ items: [contested(1), ...Array.from({ length: n - 1 }, (_, i) => plain(i))] });
    if (/À CORRIGER/.test(prompt)) return JSON.stringify({ items: [contested(call)] });
    return JSON.stringify({ items: Array.from({ length: n }, (_, i) => plain(call * 10 + i)) });
  };
  const steps: string[] = [];
  const r = await runWithCourse(id, () => generateQcmExam({ count: 3, openCount: 0, onStep: (s) => { steps.push(s); } }));
  assert.equal(r.count, 3, steps.join("\n"));
  const exam = await runWithCourse(id, () => getQcmExam(r.id, true));
  assert.ok(exam!.items.every((it) => !/\(v\d+\)/.test(it.stem)), "aucune version contestée n'est gardée");
  assertCoherent(exam!.items);
  assert.ok(steps.some((s) => /rejeté — clé contestée/.test(s)), "le rejet est dit");
  const topup = designPrompts.find((p, i) => i > 0 && !/À CORRIGER/.test(p));
  assert.match(topup ?? "", /Alignement interne et externe/, "le sujet de la question écartée est comblé");
});

test("clé confirmée mais défaut relevé (indice, ambiguïté) : aucune note ajoutée à l'explication", async () => {
  const id = await course();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  design = (n, call) => JSON.stringify({ items: Array.from({ length: n }, (_, i) => plain(call * 10 + i)) });
  const ok = judge;
  judge = () => ({ answer: /^Un État contrôle/, ok: false, issue: "la bonne option est la seule à nuancer" });
  try {
    const r = await runWithCourse(id, () => generateQcmExam({ count: 2, openCount: 0 }));
    const exam = await runWithCourse(id, () => getQcmExam(r.id, true));
    assert.equal(exam!.items.length, 2);
    assertCoherent(exam!.items);
    assert.ok(designPrompts.some((p) => /À CORRIGER[\s\S]*seule à nuancer/.test(p)), "le défaut relevé déclenche une régénération");
  } finally {
    judge = ok;
  }
});

test("examen déjà en base avec une note de vérification : ni la note ni l'explication contredite ne sont montrées", async () => {
  const id = await course();
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { getQcmExam, gradeQcm } = await import("../lib/qcm");
  const stale = `La bonne réponse est « ${ALIGN[0]} » : c'est la définition du cours. [clé corrigée à la vérif : la clé devrait être l'alignement externe]`;
  const examId = await runWithCourse(id, async () => {
    await getQcmExam(0); // crée les tables QCM du cours
    const e = await q.insert(`INSERT INTO exams (format_template, status) VALUES ('qcm','ready')`);
    const ins = `INSERT INTO qcm_items (exam_id, idx, topic, type, stem, options_json, correct_json, misconceptions_json, explanation, verified) VALUES (?,?,?,?,?,?,?,?,?,?)`;
    await q.run(ins, e, 0, "alignement", "scq", "Que désigne l'alignement interne ? (Q19)", JSON.stringify(ALIGN), "[1]", "[]", stale, 1);
    await q.run(ins, e, 1, "alignement", "scq", "Q18", JSON.stringify(ALIGN), "[0]", "[]", `${ALIGN[0]} [clé alignée sur la résolution indépendante]`, 1);
    await q.run(ins, e, 2, "souveraineté", "scq", "Q3", JSON.stringify(ALIGN), "[0]", "[]", "Explication saine.", 1);
    return e;
  });
  const exam = await runWithCourse(id, () => getQcmExam(examId, true));
  const graded = await runWithCourse(id, () => gradeQcm(examId, { 0: [1] }));
  for (const text of [...exam!.items.map((it) => it.explanation), ...graded.detail.map((d) => d.explanation)]) {
    assert.doesNotMatch(text, /\[clé (?:corrigée|alignée)/, "la note interne n'est jamais montrée");
    assert.ok(!text.includes(ALIGN[0]) || text === "Explication saine.", `explication contredite montrée : ${text}`);
  }
  assert.equal(exam!.items[2].explanation, "Explication saine.", "une explication sans note est intacte");
  assert.match(exam!.items[0].explanation, /vérification avait relevé un problème/, "l'étudiant sait pourquoi l'explication manque");
});

test("question sur la grille d'évaluation ou la forme d'un rendu : rejetée et remplacée par une question de matière", async () => {
  const id = await course();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  const rubric = item("Selon la grille d'évaluation de l'essai, que mesure le critère D1 ? (grille)", [
    "Le lien entre l'essai et un concept des sciences humaines vu en cours.",
    "La qualité de la mise en forme de la bibliographie selon les normes APA.",
    "Le respect de la longueur maximale imposée pour l'essai final.",
    "La présence d'au moins trois sources académiques dans l'essai.",
  ]);
  design = (n, call) => JSON.stringify({ items: call === 1 ? [rubric, ...Array.from({ length: n - 1 }, (_, i) => plain(i))] : Array.from({ length: n }, (_, i) => plain(call * 10 + i)) });
  const ok = judge;
  judge = (b) => (/\(grille\)/.test(b)
    ? { answer: /^Le lien entre l'essai/, offMatter: "porte sur la grille d'évaluation de l'essai, pas sur la matière du cours" }
    : { answer: /^Un État contrôle/ });
  try {
    const steps: string[] = [];
    const r = await runWithCourse(id, () => generateQcmExam({ count: 3, openCount: 0, onStep: (s) => { steps.push(s); } }));
    assert.equal(r.count, 3, steps.join("\n"));
    const exam = await runWithCourse(id, () => getQcmExam(r.id, true));
    assert.ok(exam!.items.every((it) => !/grille/i.test(it.stem)), "la question sur la grille n'est pas gardée");
    assert.ok(steps.some((s) => /rejeté — hors matière[^\n]*grille d'évaluation/.test(s)), "le rejet est dit, avec sa raison");
    assert.match(verifyPrompts[0], /modalités d'examen[\s\S]*forme d'un rendu[\s\S]*organisation du cours/, "le correcteur sait qu'il doit le relever");
    assert.match(designPrompts[0], /MATIÈRE[^\n]*modalités d'examen[^\n]*forme d'un rendu[^\n]*organisation du cours/, "la conception l'interdit d'emblée");
  } finally {
    judge = ok;
  }
});

test("banque de révision déjà en base avec une note de vérification : la note n'est pas montrée", async () => {
  const id = await course();
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { planQuestions } = await import("../lib/revision");
  const shown = await runWithCourse(id, async () => {
    await planQuestions(); // crée la table du parcours
    await q.run(`INSERT INTO revision_plan (kind, topic, statement, options, correct, explanation, verified) VALUES ('qcm',?,?,?,?,?,?)`,
      "alignement", "Que désigne l'alignement interne ?", ALIGN.join("\n"), "B", `${ALIGN[0]} [clé corrigée à la vérif : la clé devrait être l'alignement externe]`, 1);
    return planQuestions();
  });
  assert.equal(shown.length, 1);
  assert.doesNotMatch(shown[0].explanation ?? "", /\[clé (?:corrigée|alignée)/);
  assert.ok(!(shown[0].explanation ?? "").includes(ALIGN[0]), "l'explication contredite n'est pas montrée");
});

test("clé contestée, version régénérée valide mais peu discriminante : elle remplace l'item rejeté, sans lot de comblement", async () => {
  const id = await course();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  design = (n, call, prompt) => {
    if (call === 1) return JSON.stringify({ items: [contested(1), ...Array.from({ length: n - 1 }, (_, i) => plain(i))] });
    if (/À CORRIGER/.test(prompt)) return JSON.stringify({ items: [item("Que désigne l'alignement externe ? (r2)", ALIGN, 1)] });
    return JSON.stringify({ items: Array.from({ length: n }, (_, i) => plain(call * 10 + i)) });
  };
  const ok = judge;
  judge = (b) => (/\(r2\)/.test(b) ? { answer: EXTERNAL, nameOnly: true } : ok(b));
  try {
    const r = await runWithCourse(id, () => generateQcmExam({ count: 3, openCount: 0 }));
    assert.equal(r.count, 3);
    const exam = await runWithCourse(id, () => getQcmExam(r.id, true));
    assert.ok(exam!.items.some((it) => /\(r2\)/.test(it.stem)), "la version régénérée est gardée");
    assert.equal(designCalls, 2, "conception + régénération, aucun comblement");
  } finally {
    judge = ok;
  }
});
