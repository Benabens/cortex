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
// Un cours neuf par test : au-delà de 10, la garde « 10 cours par heure » refuserait la création.
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
process.env.MAX_COURSES_PER_USER = "unlimited";

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
const repairPrompts: string[] = [];
/** Remplacement d'un distracteur trivial (lib/qcm replaceTrivialDistractors) : une option proche du cours. */
function defaultRepairReply(prompt: string): string {
  const replacements = [...prompt.matchAll(/^Q(\d+)\.[\s\S]*?(?=^Q\d+\.|$(?![\s\S]))/gm)].map((m) => ({
    index: Number(m[1]),
    distractors: [...m[0].matchAll(/^\s+\((\d+)\) .* ← À REMPLACER/gm)].map((x) => ({ option: Number(x[1]), text: "La médiane des revenus calculée séparément pour chaque modalité de sex.", misconception: "[quasi-synonyme] médiane pour moyenne" })),
    explanation: "groupby puis mean donne la moyenne par groupe ; la médiane et la somme sont d'autres agrégats.",
  }));
  return JSON.stringify({ replacements });
}
let repairReply: (prompt: string) => string = defaultRepairReply;
const designBodies: Record<string, unknown>[] = [];

const verifyPrompts: string[] = [];
/** Ce que le juge met dans off_course pour chaque question (vide : rien à signaler). */
let judgeFlag = "";
function verifyReply(prompt: string): string {
  verifyPrompts.push(prompt);
  const blocks = prompt.split(/^(?=Q\d+\.)/m).filter((b) => /^Q\d+\./.test(b));
  const results = blocks.map((b) => {
    const i = Number(/^Q(\d+)\./.exec(b)![1]);
    const opt = [...b.matchAll(/^\s+\((\d+)\) (.*)$/gm)].find((m) => /moyenne des revenus calculée séparément|Status quo bias explains/.test(m[2]));
    // Le juge cite les termes du cours dont dépend la clé ; pour la question « status quo », il ne
    // remarque pas que la notion manque au cours (le contrôle déterministe doit l'attraper).
    const course_terms = /Status quo/.test(b) ? ["status quo bias", "groupthink"] : ["groupby"];
    // K — le juge repère un distracteur qu'on élimine sans connaître le cours (« TypeError » hors sujet).
    const trivial = [...b.matchAll(/^\s+\((\d+)\) (.*)$/gm)].filter((m) => /TypeError/.test(m[2])).map((m) => Number(m[1]));
    // B — le juge compare les définitions employées à celles des extraits du cours.
    const definition_mismatch = /legally protected/.test(b)
      ? "sensitive attribute : la question le restreint aux attributs protégés par la loi ; le cours : par la loi OU par l'éthique (couleur de cheveux)"
      : /latent variable is a proxy/.test(b)
        ? "latent variable : le cours la définit comme non observable, mesurée indirectement — pas comme un proxy enregistré"
        : "";
    return { index: i, correct: [opt ? Number(opt[1]) : 0], ok: true, discrimination: 4, name_only: false, issue: "", course_terms, off_course: judgeFlag, trivial_distractors: trivial, definition_mismatch };
  });
  return JSON.stringify({ results });
}

const DESIGN = { misconception: "confondre FPR et FDR", edge_case: "groupes de tailles différentes", reasoning_chain: ["a", "b"], bookkeeping: "tableau 2×2", discriminator: "FDR", awkward_numbers: "37, 113", subquestion_plan: ["a", "b"] };
const AUDIT_GOOD = { pattern_matcher_answer: "FDR", pattern_matcher_correct: false, strong_student_answer: "FPR", strong_student_stuck: false, rubric_misses: [], trap_present: true, hardening: "", verdict: "good" };
let writeCalls = 0;
const assistPrompts: string[] = [];
const dedupePrompts: string[] = [];
/** Paires en doublon que rend le contrôle de fin d'examen (aucune par défaut). */
let dedupe: (prompt: string) => { first: number; second: number; reason: string }[] = () => [];
/** Drill : n = rang de l'appel. */
let drill: (n: number) => string = () => "{}";
const VERDICT = { verdict: "correct", feedback: "Conforme au cours.", correct_solution: "Groupthink.", criteria: [
  { label: "Nomme le biais du cours", points: 1, achieved: true, essential: true, justification: "Groupthink est nommé." },
  { label: "Justifie", points: 1, achieved: true, essential: false, justification: "Le silence du groupe est expliqué." },
] };
/** Rédaction d'une question ouverte (n = rang de l'appel). */
let write: (n: number, prompt: string) => string = (n) => JSON.stringify({ category: "Fairness", concept: `Ouverte ${n}`, statement_tex: `\\textbf{Scénario ${n}.} Calculez le FPR de chaque groupe.`, solution_tex: "FPR = FP / (FP + TN).", points: 15 });

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
      if (/"replacements"/.test(content)) { repairPrompts.push(content); text = repairReply(content); }
      else if (/"duplicates"/.test(content)) { dedupePrompts.push(content); text = JSON.stringify({ duplicates: dedupe(content) }); }
      else if (/"hints"/.test(content)) { assistPrompts.push(content); text = drill(assistPrompts.length); }
      else if (/RÉPONSE DE L'ÉTUDIANT/.test(content)) { assistPrompts.push(content); text = JSON.stringify(VERDICT); }
      else if (/"edge_case"/.test(content)) text = JSON.stringify(DESIGN);
      else if (/"pattern_matcher_answer"/.test(content)) text = JSON.stringify(AUDIT_GOOD);
      else if (/"statement_tex"/.test(content)) { writeCalls++; text = write(writeCalls, content); }
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

beforeEach(() => { repairPrompts.length = 0; repairReply = defaultRepairReply; dedupePrompts.length = 0; dedupe = () => []; assistPrompts.length = 0; designCalls = 0; writeCalls = 0; designPrompts.length = 0; designBodies.length = 0; verifyPrompts.length = 0; });

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL", "MAX_COURSES_CREATED_PER_HOUR", "MAX_COURSES_PER_USER"]) delete process.env[k];
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
  // Budget borné : les 2 lots prévus, plus au plus 2 × 2 lots de comblement et de complément final.
  assert.ok(designCalls <= 6, `budget de comblement borné (${designCalls} lots demandés pour 2 prévus)`);
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
  // L'ouverte sur « pandas groupby » (une seule l'a) ne rend que du texte à ses 3 premiers essais : elle
  // échoue, puis est relancée (les ouvertes tournent en parallèle : ciblée par son sujet).
  let target = 0;
  write = (n, p) => (/pandas groupby/.test(p) && ++target <= 3 ? "Voici l'énoncé demandé." : ok(n, p));
  try {
    const steps: string[] = [];
    const r = await runWithCourse(id, () => generateQcmExam({ count: 2, openCount: 3, onStep: (s) => { steps.push(s); } }));
    assert.equal(r.open, 3, steps.filter((s) => /uverte/.test(s)).join("\n"));
    assert.equal(r.openRequested, 3);
    assert.equal(target, 4, "trois essais ratés, puis la relance");
    assert.ok(steps.some((s) => /Question ouverte \d ignorée : le modèle a renvoyé une réponse illisible/.test(s)), "l'échec est dit, avec sa cause");
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

test("un juge qui répond « None » dans off_course ne rejette rien", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam } = await import("../lib/qcm");
  design = (n) => JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(i)) });
  judgeFlag = "None";
  try {
    const steps: string[] = [];
    const r = await runWithCourse(id, () => generateQcmExam({ count: 3, openCount: 0, onStep: (s) => { steps.push(s); } }));
    assert.equal(r.count, 3);
    assert.ok(!steps.some((s) => /hors cours/.test(s)), steps.filter((s) => /hors cours/.test(s)).join("\n"));
    assert.equal(designCalls, 1, "aucune régénération");
  } finally {
    judgeFlag = "";
  }
});

test("H — deux QCM sur la même notion : le second est retiré et remplacé par une autre notion", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  design = (n, call) => JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(10 * call + i, `Simpson ${call}.${i} : que montre le tableau agrégé ? (Q${call}.${i})`)) });
  dedupe = (p) => (/Simpson 1\.0/.test(p) && /Simpson 1\.2/.test(p) ? [{ first: 0, second: 2, reason: "même paradoxe de Simpson" }] : []);
  const steps: string[] = [];
  const r = await runWithCourse(id, () => generateQcmExam({ count: 3, openCount: 0, onStep: (s) => { steps.push(s); } }));
  assert.equal(r.count, 3);
  const stems = (await runWithCourse(id, () => getQcmExam(r.id)))!.items.map((x) => x.stem);
  assert.ok(!stems.some((x) => x.startsWith("Simpson 1.2")), stems.join(" | "));
  assert.ok(stems.some((x) => x.startsWith("Simpson 2.")), "remplacé par un nouveau lot");
  assert.ok(steps.some((x) => /doublon/.test(x)), "le retrait est dit");
});

test("H — les questions des examens précédents du même cours ne sont pas reprises", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam } = await import("../lib/qcm");
  design = (n, call) => JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(i, `Ancienne ${call}.${i} : que renvoie groupby ? (Q${call}.${i})`)) });
  await runWithCourse(id, () => generateQcmExam({ count: 2, openCount: 0 }));
  designPrompts.length = 0;
  await runWithCourse(id, () => generateQcmExam({ count: 2, openCount: 0 }));
  assert.match(designPrompts[0], /examens précédents[\s\S]*Ancienne 1\.0/, "les énoncés déjà posés sont donnés à ne pas reprendre");
});

test("K — niveau examen réel par défaut ; un distracteur éliminable sans le cours (« TypeError ») est remplacé", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  // Mock 4 de CS-290 (consigne neutre) : distracteurs « erreur d'arrondi », « TypeError ».
  const easy = { ...item(0), options: ["La moyenne des revenus calculée séparément pour chaque modalité de sex.", "Une TypeError, car groupby ne s'applique pas à une colonne texte.", "Une erreur d'arrondi due aux nombres flottants de la colonne income.", "La somme des revenus calculée séparément pour chaque modalité de sex."] };
  design = (n, call) => JSON.stringify({ items: call === 1 ? [easy, ...Array.from({ length: n - 1 }, (_, i) => item(1 + i))] : Array.from({ length: n }, (_, i) => item(10 * call + i)) });
  const r = await runWithCourse(id, () => generateQcmExam({ count: 2, openCount: 0 }));
  assert.equal(r.count, 2);
  assert.match(designPrompts[0], /NIVEAU EXAMEN RÉEL/, "la difficulté d'examen est le défaut, sans consigne");
  // Banc du 04/11 : seule l'option triviale est remplacée, l'énoncé et la clé restent.
  assert.match(repairPrompts[0] ?? "", /TypeError.*← À REMPLACER/, "remplacement ciblé sur le distracteur trivial");
  assert.ok(!designPrompts.some((p) => /À CORRIGER/.test(p)), "aucune question régénérée en entier");
  const options = (await runWithCourse(id, () => getQcmExam(r.id)))!.items.flatMap((x) => x.options);
  assert.ok(!options.some((o) => /TypeError/.test(o)), options.join(" | "));
});

test("K — un distracteur encore trivial après remplacement est réparé une seconde fois", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  const easy = { ...item(0), options: ["La moyenne des revenus calculée séparément pour chaque modalité de sex.", "Une TypeError, car groupby ne s'applique pas à une colonne texte.", "Le nombre de lignes de chaque modalité de sex, sans calcul de moyenne.", "La somme des revenus calculée séparément pour chaque modalité de sex."] };
  design = (n, call) => JSON.stringify({ items: call === 1 ? [easy, ...Array.from({ length: n - 1 }, (_, i) => item(1 + i))] : Array.from({ length: n }, (_, i) => item(10 * call + i)) });
  let repairs = 0;
  repairReply = (prompt) => {
    repairs++;
    if (repairs === 1) {
      return defaultRepairReply(prompt).replace("La médiane des revenus calculée séparément pour chaque modalité de sex.", "Une TypeError provoquée par la modalité de sex.");
    }
    return defaultRepairReply(prompt);
  };

  const r = await runWithCourse(id, () => generateQcmExam({ count: 2, openCount: 0 }));

  assert.equal(repairPrompts.length, 2, "le défaut persistant déclenche une seconde réparation ciblée");
  const options = (await runWithCourse(id, () => getQcmExam(r.id)))!.items.flatMap((x) => x.options);
  assert.ok(!options.some((o) => /TypeError/.test(o)), options.join(" | "));
});

test("K — après deux réparations insuffisantes, la question est régénérée avant le comblement", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam } = await import("../lib/qcm");
  const easy = { ...item(0), options: ["La moyenne des revenus calculée séparément pour chaque modalité de sex.", "Une TypeError, car groupby ne s'applique pas à une colonne texte.", "Le nombre de lignes de chaque modalité de sex, sans calcul de moyenne.", "La somme des revenus calculée séparément pour chaque modalité de sex."] };
  design = (n, call) => JSON.stringify({ items: call === 1 ? [easy, ...Array.from({ length: n - 1 }, (_, i) => item(1 + i))] : Array.from({ length: n }, (_, i) => item(10 * call + i)) });
  repairReply = (prompt) => defaultRepairReply(prompt).replace("La médiane des revenus calculée séparément pour chaque modalité de sex.", "Une TypeError provoquée par la modalité de sex.");

  const r = await runWithCourse(id, () => generateQcmExam({ count: 2, openCount: 0 }));

  assert.equal(r.count, 2);
  assert.ok(designPrompts.some((p) => /À CORRIGER/.test(p)), "régénération ciblée avant un lot générique de comblement");
});

test("K — la consigne de l'étudiant s'ajoute au niveau par défaut, sur chaque lot", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam } = await import("../lib/qcm");
  design = (n) => JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(i)) });
  await runWithCourse(id, () => generateQcmExam({ count: 6, openCount: 0, focus: "HARD : distinctions fines entre notions proches" }));
  const firsts = designPrompts.filter((p) => !/À CORRIGER/.test(p));
  assert.ok(firsts.length >= 2);
  for (const p of firsts) {
    assert.match(p, /NIVEAU EXAMEN RÉEL/);
    assert.match(p, /CONSIGNE DE L'ÉTUDIANT[^\n]*HARD : distinctions fines/);
  }
});

test("M — ouvertes en parallèle des QCM, QCM visibles avant les ouvertes, durées des phases journalisées", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  design = (n) => JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(i)) });
  const steps: string[] = [];
  let early: { examId: number; items: number; open: number; status: string | null } | null = null;
  const r = await runWithCourse(id, () => generateQcmExam({
    count: 4, openCount: 2,
    onStep: (s) => { steps.push(s); },
    onExamReady: async (examId) => {
      const v = await getQcmExam(examId);
      early = { examId, items: v?.items.length ?? 0, open: v?.open.length ?? 0, status: v?.status ?? null };
    },
  }));
  assert.ok(early, "l'examen est livré dès que ses QCM sont prêts");
  assert.deepEqual(early, { examId: r.id, items: 4, open: 0, status: "generating" }, "QCM visibles, ouvertes en cours");
  const firstOpen = steps.findIndex((x) => /Question ouverte 1\/2/.test(x));
  const qcmDone = steps.findIndex((x) => /4\/4 QCM construits/.test(x));
  assert.ok(firstOpen >= 0 && firstOpen < qcmDone, "les ouvertes démarrent avant la fin des QCM");
  for (const phase of [/⏱ QCM/, /⏱ Questions ouvertes/, /⏱ PDF/, /⏱ Total/]) assert.ok(steps.some((x) => phase.test(x)), String(phase));
  const final = await runWithCourse(id, () => getQcmExam(r.id));
  assert.equal(final!.status, "ready");
  assert.equal(final!.open.length, 2);
});

test("M — cache de prompt : le contexte stable d'un job est le même « system » pour tous ses lots", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam } = await import("../lib/qcm");
  design = (n) => JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(i)) });
  await runWithCourse(id, () => generateQcmExam({ count: 7, openCount: 0 }));
  type Msg = { role: string; content: string };
  const lots = designBodies.map((b) => (b as { messages: Msg[] }).messages).filter((m) => !/À CORRIGER/.test(m.map((x) => x.content).join("\n")));
  assert.ok(lots.length >= 2, `${lots.length} lots`);
  const system = lots.map((m) => m.find((x) => x.role === "system")?.content ?? "");
  assert.ok(system[0].length > 2000, "un préfixe assez long pour le cache (règles, taxonomie, schéma)");
  assert.equal(system[1], system[0], "identique d'un lot à l'autre : lu en cache après le premier");
  assert.match(system[0], /NIVEAU EXAMEN RÉEL[\s\S]*TAXONOMIE DES DISTRACTEURS[\s\S]*"items"/);
  const user = lots[0].find((x) => x.role === "user")?.content ?? "";
  assert.match(user, /Couvre ces sujets/);
  assert.doesNotMatch(user, /TAXONOMIE DES DISTRACTEURS/, "le variable reste hors du préfixe caché");
});

test("B — une définition plus étroite ou confondue avec une autre (sensitive, latent/proxy) est rejetée et remplacée", async () => {
  const id = await codeCourse();
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  // Définitions du cours (paraphrasées) : sensible par la loi OU l'éthique ; proxy ; variable latente.
  const defs = "Fairness 1, théorie. Sensitive attributes : protégés par la loi OU par l'éthique (la couleur de cheveux est sensible : observée, subjective). Proxy attributes : corrélés à un attribut sensible, d'où la discrimination by proxy. Latent variable : non observable, mesurée indirectement (l'intérêt mesuré par les clics).";
  await runWithCourse(id, async () => {
    ensureFts();
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "note", "Fairness 1 - sources of unfairness", "note/f1", null, 1);
    const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "note", "Fairness 1 - sources of unfairness", defs);
    await indexItemForSearch(iid, sid, "Fairness 1 - sources of unfairness", defs);
    await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, "Sensitive / proxy / latent attributes", null, 9, 1);
  });
  const narrow = { ...item(0, "Mock 4, Q3 : an attribute is sensitive only when it is explicitly recorded and legally protected. True for which case?"), topic: "Sensitive / proxy / latent attributes" };
  const merged = { ...item(1, "In the course, a latent variable is a proxy attribute recorded in the dataset. Which example fits?"), topic: "Sensitive / proxy / latent attributes" };
  design = (n, call) => JSON.stringify({ items: call === 1 ? [narrow, merged, ...Array.from({ length: Math.max(0, n - 2) }, (_, i) => item(2 + i))] : Array.from({ length: n }, (_, i) => item(10 * call + i)) });
  const steps: string[] = [];
  const r = await runWithCourse(id, () => generateQcmExam({ count: 3, openCount: 0, onStep: (x) => { steps.push(x); } }));
  assert.equal(r.count, 3);
  const stems = (await runWithCourse(id, () => getQcmExam(r.id)))!.items.map((x) => x.stem);
  assert.ok(!stems.some((x) => /legally protected|latent variable is a proxy/.test(x)), stems.join(" | "));
  assert.ok(steps.some((x) => /définition différente du cours[^\n]*sensitive attribute/.test(x)), "le rejet nomme la définition en cause");
  const judged = verifyPrompts.find((p) => /legally protected/.test(p)) ?? "";
  assert.match(judged, /plus étroite[\s\S]*plus large/, "le juge doit comparer chaque définition à celle du cours");
  assert.match(judged, /EXTRAITS DU COURS[\s\S]*OU par l'éthique/, "avec les définitions du cours sous les yeux");
});


// ─────────── TEMPS RESTANT : l'avancement d'un examen ne recule jamais sans réessai ───────────
// Depuis le parallélisme (M), les ouvertes publiaient 82 % dès le départ, puis les lots de QCM
// 30 %, puis 70 % ; les lignes de journal (« ⏱ QCM : … », « régénération ciblée ») publiaient
// 0 %. Le temps restant, calculé sur l'avancement, remontait sans raison.
/** Les reculs d'avancement d'une étape à la suivante, avec leur message. */
const regressions = (seq: { s: string; p: number }[]) => seq.filter((x, i) => i > 0 && x.p < seq[i - 1].p).map((x) => `${x.p} % — ${x.s}`);

test("ETA — sans réessai, l'avancement d'un examen QCM (lots et ouvertes en parallèle) ne recule jamais", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam } = await import("../lib/qcm");
  design = (n) => JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(i)) });
  const seq: { s: string; p: number }[] = [];
  await runWithCourse(id, () => generateQcmExam({ count: 8, openCount: 2, onStep: (s, p) => { seq.push({ s, p }); } }));
  assert.deepEqual(regressions(seq), [], seq.map((x) => `${x.p} ${x.s}`).join("\n"));
  assert.equal(seq.at(-1)?.p, 100);
});

test("ETA — l'avancement ne recule qu'à l'ajout d'un réessai (une ouverte relancée)", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam } = await import("../lib/qcm");
  design = (n) => JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(i)) });
  const ok = write;
  let target = 0;
  write = (n, p) => (/pandas groupby/.test(p) && ++target <= 3 ? "Voici l'énoncé demandé." : ok(n, p));
  try {
    const seq: { s: string; p: number }[] = [];
    await runWithCourse(id, () => generateQcmExam({ count: 2, openCount: 3, onStep: (s, p) => { seq.push({ s, p }); } }));
    const back = regressions(seq);
    assert.ok(back.every((x) => /→ nouvel essai/.test(x)), `recul hors réessai :\n${back.join("\n")}`);
  } finally {
    write = ok;
  }
});
