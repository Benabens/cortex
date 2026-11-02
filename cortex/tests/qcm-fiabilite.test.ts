/**
 * FIABILITÉ DE LA GÉNÉRATION QCM — cas de prod du 01/11 (CS-290) : des énoncés
 * avec du code pandas faisaient échouer le parsing de chaque lot, d'où des
 * examens à 3 QCM sur 7, ou à 0 (« tous les lots ont échoué »).
 * Verrouillé, avec un faux modèle qui renvoie les sorties problématiques :
 *  - un lot enveloppé de ```json dont un énoncé contient un bloc ```python est lu ;
 *  - un lot illisible est redemandé avec l'erreur précise ;
 *  - les QCM manquants sont comblés jusqu'au nombre demandé, dans un budget borné ;
 *  - sinon l'examen DIT combien de questions il a sur combien demandées.
 * Fournisseur LLM simulé (openai-compatible) : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-fiab-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";

const BT = "```";
const CODE_STEM = `Considérez le code suivant :\n${BT}python\nimport pandas as pd\ndf = pd.DataFrame({"sex": ["F", "M"], "income": [3, 5]})\nprint(df.groupby("sex")["income"].mean())\n${BT}\nQue fait la dernière ligne ?`;

function item(i: number, stem = `Que renvoie df.groupby("sex")["income"].mean() ? (Q${i})`) {
  return {
    topic: "pandas groupby",
    type: "scq",
    stem,
    options: [
      "La moyenne des revenus calculée séparément pour chaque modalité de sex.",
      "La moyenne des revenus calculée sur toutes les lignes, sans regroupement.",
      "Le nombre de lignes de chaque modalité de sex, sans calcul de moyenne.",
      "La somme des revenus calculée séparément pour chaque modalité de sex.",
    ],
    correct: [0],
    misconceptions: ["", "[sur-généralisation] ignore le regroupement", "[notion voisine] confond mean et count", "[notion voisine] confond mean et sum"],
    explanation: "groupby regroupe par modalité de sex, puis mean calcule la moyenne des revenus de chaque groupe.",
  };
}

/** Réponse du modèle à un appel de conception de lot : n = nombre de QCM demandés au lot. */
let design: (n: number, call: number, prompt: string) => string = (n) => JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(i)) });
let designCalls = 0;
const designPrompts: string[] = [];
const designBodies: Record<string, unknown>[] = [];

const verifyPrompts: string[] = [];
function verifyReply(prompt: string): string {
  verifyPrompts.push(prompt);
  const blocks = prompt.split(/^(?=Q\d+\.)/m).filter((b) => /^Q\d+\./.test(b));
  const results = blocks.map((b) => {
    const i = Number(/^Q(\d+)\./.exec(b)![1]);
    const opt = [...b.matchAll(/^\s+\((\d+)\) (.*)$/gm)].find((m) => /moyenne des revenus calculée séparément|Status quo bias explains/.test(m[2]));
    // Le juge cite les termes du cours dont dépend la clé ; pour la question « status quo », il ne
    // remarque pas que la notion manque au cours (le contrôle déterministe doit l'attraper).
    const course_terms = /Status quo/.test(b) ? ["status quo bias", "groupthink"] : ["groupby"];
    return { index: i, correct: [opt ? Number(opt[1]) : 0], ok: true, discrimination: 4, name_only: false, issue: "", course_terms, off_course: "" };
  });
  return JSON.stringify({ results });
}

const DESIGN = { misconception: "confondre FPR et FDR", edge_case: "groupes de tailles différentes", reasoning_chain: ["a", "b"], bookkeeping: "tableau 2×2", discriminator: "FDR", awkward_numbers: "37, 113", subquestion_plan: ["a", "b"] };
const AUDIT_GOOD = { pattern_matcher_answer: "FDR", pattern_matcher_correct: false, strong_student_answer: "FPR", strong_student_stuck: false, rubric_misses: [], trap_present: true, hardening: "", verdict: "good" };
let writeCalls = 0;
const assistPrompts: string[] = [];
/** Drill : n = rang de l'appel. */
let drill: (n: number) => string = () => "{}";
const VERDICT = { verdict: "correct", feedback: "Conforme au cours.", correct_solution: "Groupthink.", criteria: [
  { label: "Nomme le biais du cours", points: 1, achieved: true, essential: true, justification: "Groupthink est nommé." },
  { label: "Justifie", points: 1, achieved: true, essential: false, justification: "Le silence du groupe est expliqué." },
] };
/** Rédaction d'une question ouverte (n = rang de l'appel). */
let write: (n: number) => string = (n) => JSON.stringify({ category: "Fairness", concept: `Ouverte ${n}`, statement_tex: `\\textbf{Scénario ${n}.} Calculez le FPR de chaque groupe.`, solution_tex: "FPR = FP / (FP + TN).", points: 15 });

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
      // Architecte des questions ouvertes (conception → rédaction → audit), testé avant "items" :
      // le schéma de conception contient lui aussi des tableaux « "items" ».
      if (/"hints"/.test(content)) { assistPrompts.push(content); text = drill(assistPrompts.length); }
      else if (/RÉPONSE DE L'ÉTUDIANT/.test(content)) { assistPrompts.push(content); text = JSON.stringify(VERDICT); }
      else if (/"edge_case"/.test(content)) text = JSON.stringify(DESIGN);
      else if (/"pattern_matcher_answer"/.test(content)) text = JSON.stringify(AUDIT_GOOD);
      else if (/"statement_tex"/.test(content)) { writeCalls++; text = write(writeCalls); }
      else if (/"results"/.test(content)) text = verifyReply(content);
      else if (/"items"/.test(content)) {
        designCalls++;
        designPrompts.push(content);
        designBodies.push(parsed as unknown as Record<string, unknown>);
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

beforeEach(() => { assistPrompts.length = 0; designCalls = 0; writeCalls = 0; designPrompts.length = 0; designBodies.length = 0; verifyPrompts.length = 0; });

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

let courseN = 0;
async function codeCourse(): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const row = buildCourseRow({ name: `Responsible Software ${++courseN}`, code: "CS-290", language: "fr", examFormat: { kind: "qcm", questionCount: 7 } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
    const text = "Notebook 3 : df.groupby('sex')['income'].mean() calcule la moyenne des revenus par groupe. Cognitive biases in design: stereotypes, confirmation bias, groupthink (no one voices a concern because no one else objects), sunk cost fallacy.";
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", "Notebook pandas", "course_pdf/nb3", null, 1);
    const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", "Notebook pandas", text);
    await indexItemForSearch(iid, sid, "Notebook pandas", text);
    for (const label of ["pandas groupby", "Biais des données", "Équité algorithmique"]) {
      await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, null, 3, 1);
    }
  });
  return row.id;
}

test("sorties problématiques du modèle → 7 QCM sur 7, code des énoncés intact", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  design = (n, call) => {
    // 1ᵉʳ lot : enveloppé de ```json, un énoncé avec un bloc ```python (cas de prod).
    if (call === 1) return `${BT}json\n${JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(i, i === 0 ? CODE_STEM : undefined)) }, null, 2)}\n${BT}`;
    // 2ᵉ lot : prose sans JSON, puis, redemandé, un QCM de moins que demandé.
    if (call === 2) return "Voici les QCM demandés, conformes au format du cours.";
    if (call === 3) return JSON.stringify({ items: Array.from({ length: n - 1 }, (_, i) => item(10 + i)) });
    return JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(20 + i)) });
  };
  const r = await runWithCourse(id, () => generateQcmExam({ count: 7, openCount: 0 }));
  assert.equal(r.count, 7, "le QCM manquant est comblé");
  assert.equal(r.requested, 7);
  const retry = designPrompts.find((p) => /n'était pas un JSON valide/.test(p));
  assert.ok(retry, "le lot illisible est redemandé avec l'erreur");
  assert.match(retry!, /sans JSON/);
  assert.ok(designBodies.every((b) => b.response_format), "la conception demande une sortie structurée");
  const exam = await runWithCourse(id, () => getQcmExam(r.id));
  assert.equal(exam!.items.length, 7);
  assert.ok(exam!.items.some((it) => it.stem.includes(`${BT}python\nimport pandas as pd`)), "le bloc de code de l'énoncé est gardé tel quel");
  assert.doesNotMatch(exam!.verifySummary ?? "", /sur 7/, "un examen complet ne signale rien");
});

test("le modèle ne rend jamais assez de QCM : comblement borné, et l'examen dit « n sur 7 »", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  design = (_n, call) => JSON.stringify({ items: [item(call)] });
  const r = await runWithCourse(id, () => generateQcmExam({ count: 7, openCount: 0 }));
  assert.ok(r.count > 0 && r.count < 7, `count=${r.count}`);
  assert.equal(r.requested, 7);
  assert.ok(designCalls <= 4, `budget de comblement borné (${designCalls} lots demandés pour 2 prévus)`);
  const exam = await runWithCourse(id, () => getQcmExam(r.id));
  assert.match(exam!.verifySummary ?? "", new RegExp(`${r.count} sur 7`));
});

test("aucun lot lisible : erreur claire qui dit pourquoi, jamais « unknown »", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam } = await import("../lib/qcm");
  design = () => "Je ne peux pas produire ce JSON.";
  await assert.rejects(
    runWithCourse(id, () => generateQcmExam({ count: 4, openCount: 0 })),
    (e: unknown) => e instanceof Error && /Aucun QCM généré/.test(e.message) && /illisible/.test(e.message),
  );
  assert.ok(designCalls <= 6, `essais bornés (${designCalls})`);
});

test("un item mal formé au milieu d'un lot : c'est SON sujet qui est comblé", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam } = await import("../lib/qcm");
  design = (n, call) => {
    const items = Array.from({ length: n }, (_, i) => item(call * 10 + i));
    if (call === 1) items[1] = { ...items[1], options: [] }; // 2ᵉ QCM du 1ᵉʳ lot inutilisable
    return JSON.stringify({ items });
  };
  const r = await runWithCourse(id, () => generateQcmExam({ count: 3, openCount: 0 }));
  assert.equal(r.count, 3);
  const subjects = (p: string) => [...p.matchAll(/^ {2}(\d+)\) (.+?)(?: \[|$)/gm)].map((m) => m[2].trim());
  const first = subjects(designPrompts[0]);
  const topup = subjects(designPrompts[1]);
  assert.deepEqual(topup, [first[1]], `comblé : ${topup.join(" | ")} ; lot : ${first.join(" | ")}`);
});

test("une question ouverte qui échoue est relancée : 2 QCM + 3 ouvertes sur 2 + 3", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  design = (n) => JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(i)) });
  const ok = write;
  // La 2ᵉ ouverte (rédactions 2 à 4 : 3 essais) ne rend que du texte : elle échoue, puis est relancée.
  write = (n) => (n >= 2 && n <= 4 ? "Voici l'énoncé demandé." : ok(n));
  try {
    const steps: string[] = [];
    const r = await runWithCourse(id, () => generateQcmExam({ count: 2, openCount: 3, onStep: (s) => { steps.push(s); } }));
    assert.equal(r.open, 3, steps.filter((s) => /uverte/.test(s)).join("\n"));
    assert.equal(r.openRequested, 3);
    assert.ok(steps.some((s) => /Question ouverte 2 ignorée/.test(s)), "l'échec est dit, avec sa cause");
    assert.ok(steps.some((s) => /ouverte\(s\) manquante\(s\)/.test(s)), "et la relance aussi");
    const exam = await runWithCourse(id, () => getQcmExam(r.id));
    assert.equal(exam!.open.length, 3);
  } finally {
    write = ok;
  }
});

test("une clé qui repose sur une notion absente du cours (« status quo bias ») est rejetée et remplacée", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  const offCourse = {
    ...item(0, "A team keeps an outdated authentication mechanism to avoid the effort of change, and nobody voices concerns because no one else objects first. Which pair of biases explains (1) and (2)?"),
    options: [
      "Status quo bias explains the reluctance to change, while groupthink explains the silence in the meeting.",
      "Groupthink explains the reluctance to change, while confirmation bias explains the silence in the meeting.",
      "Confirmation bias explains the reluctance to change, while sunk cost fallacy explains the silence in the meeting.",
      "Sunk cost fallacy explains the reluctance to change, while stereotypes explain the silence in the meeting.",
    ],
  };
  design = (n, call) => JSON.stringify({ items: call === 1 ? [offCourse, ...Array.from({ length: n - 1 }, (_, i) => item(1 + i))] : Array.from({ length: n }, (_, i) => item(10 * call + i)) });
  const steps: string[] = [];
  const r = await runWithCourse(id, () => generateQcmExam({ count: 3, openCount: 0, onStep: (s) => { steps.push(s); } }));
  assert.equal(r.count, 3, steps.join("\n"));
  const exam = await runWithCourse(id, () => getQcmExam(r.id));
  assert.ok(exam!.items.every((it) => !/Status quo/i.test(`${it.stem} ${it.options.join(" ")}`)), "la question hors cours n'est pas gardée");
  assert.ok(steps.some((s) => /hors cours[^\n]*status quo bias/i.test(s)), "le rejet est dit, avec la notion en cause");
  assert.match(verifyPrompts[0], /EXTRAITS DU COURS[\s\S]*groupthink/, "le juge voit les définitions du cours");
});

test("drill : définitions du cours fournies, et une notion absente du cours est redemandée", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateDrill } = await import("../lib/drill");
  const base = { concept: "Cognitive biases", statement_html: "<p>A team stays silent in a meeting.</p>", hints: ["a", "b", "c", "d", "e"], solution_html: "<p>Groupthink.</p>" };
  drill = (n) => JSON.stringify({ ...base, course_terms: n === 1 ? ["status quo bias"] : ["groupthink"] });
  const d = await runWithCourse(id, () => generateDrill("cognitive biases in design"));
  assert.equal(d.solution_html, "<p>Groupthink.</p>");
  assert.equal((d as { course_terms?: unknown }).course_terms, undefined, "les termes contrôlés ne sortent pas du moteur");
  assert.equal(assistPrompts.length, 2);
  assert.match(assistPrompts[0], /EXTRAITS DU COURS[\s\S]*groupthink/, "le drill voit les définitions du cours");
  assert.match(assistPrompts[1], /notions absentes du cours : status quo bias/);
});

test("check-solution : la correction juge avec les définitions du cours", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { checkSolution } = await import("../lib/check-solution");
  const r = await runWithCourse(id, () => checkSolution({ statement: "Which cognitive bias explains why nobody voices a concern in the meeting?", answer: "Groupthink" }));
  assert.equal(r.verdict, "correct");
  assert.match(assistPrompts[0], /DÉFINITIONS DU COURS[\s\S]*EXTRAITS DU COURS[\s\S]*groupthink/);
});

