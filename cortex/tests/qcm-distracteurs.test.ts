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
const FOREIGN = "Une affirmation qui nomme une notion étrangère au cours.";
/** Troisième option des QCM conçus : triviale par défaut, ou une notion hors du cours. */
let third = ABSURD;
/** Le correcteur rend la clé en nombre (« correct: 0 ») au lieu d'un tableau. */
let scalarKey = false;
/** Le correcteur trouve une autre réponse que la clé, pour chaque question (clé contestée). */
let contestKey = false;
/** Le correcteur juge chaque question réussie avec les seuls noms des notions (autre faiblesse). */
let nameOnly = false;
const NEW_DISTRACTOR = "Une affirmation proche du cours, fausse à une condition près.";

function item(q: number) {
  return {
    topic: "CS-290", type: "scq", stem: `Question ${q} : que dit le cours sur la notion ${q} ?`,
    options: ["Une affirmation juste, tirée du cours. (clé)", "Une affirmation inversée par rapport au cours.", third, "Une affirmation attribuée à la mauvaise étude."],
    correct: [0], misconceptions: ["", "[inversion] x", "[remplissage] x", "[mauvaise attribution] x"],
    explanation: "La bonne réponse reprend le cours ; l'inversion et la mauvaise attribution le déforment.",
    source_fact: "Équité des modèles, taux de faux positifs, impact disparate, modération de contenus.",
  };
}

let designCalls = 0;
let designPrompts: string[] = [];
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
    const foreign = opts.filter((m) => m[2].startsWith("Une affirmation qui nomme une notion étrangère")).map((m) => Number(m[1]));
    return {
      index, correct: contestKey ? [key && Number(key[1]) === 0 ? 1 : 0] : scalarKey ? (key ? Number(key[1]) : 0) : [key ? Number(key[1]) : 0], ok: true, discrimination: 4, name_only: nameOnly, issue: "", course_terms: [],
      off_course: foreign.length ? "Une mauvaise option nomme une notion que le cours ne présente pas." : "", off_course_terms: foreign.length ? ["notion étrangère"] : [],
      off_course_options: foreign, off_course_key: false, off_matter: "", trivial_distractors: trivial, definition_mismatch: "",
    };
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
      else if (/"offCourse"/.test(content)) text = JSON.stringify({ verdicts: [...content.matchAll(/^Q(\d+)\./gm)].map((m) => ({ index: Number(m[1]), key: true, offCourse: false, trivial: [] })) });
      else if (/"results"/.test(content)) text = verifyReply(content);
      else if (/"items"/.test(content)) {
        designCalls++;
        designPrompts.push(content);
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

beforeEach(() => { designCalls = 0; designPrompts = []; repairCalls = 0; repairPrompts = []; replacement = NEW_DISTRACTOR; third = ABSURD; scalarKey = false; contestKey = false; nameOnly = false; });

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

test("le remplaçant reste trivial à la revérification : une seule réparation groupée puis régénération", async () => {
  replacement = "Une option absurde que tout étudiant élimine encore.";
  const result = await exam(await course(), 4).then((x) => ({ ...x, error: "" }), (e: Error) => ({ r: null, steps: [] as string[], items: [], error: e.message }));
  assert.ok(repairCalls <= 4, `une seule réparation groupée par ronde, reçu ${repairCalls}`);
  assert.ok(designCalls > 1, "le défaut persistant déclenche une régénération ou un comblement");
  if (result.r) {
    assert.ok(result.steps.some((s) => /à régénérer après une réparation/.test(s)), result.steps.join("\n"));
    for (const it of result.items) assert.ok(!it.options.some((o) => o.startsWith("Une option absurde")), "aucun verdict trivial n'est masqué dans l'examen livré");
  } else {
    assert.match(result.error, /contrôles de qualité/, result.error);
  }
  assert.ok(!result.steps.some((s) => /seconde réparation/.test(s)), result.steps.join("\n"));
});

test("la conception calcul et code impose des erreurs plausibles qui exigent le cours", async () => {
  third = "Une affirmation qui change une condition du cours.";
  await exam(await course(), 1);
  const prompt = designPrompts[0] ?? "";
  // La règle est portée par le système de conception, pas seulement par la réparation.
  assert.match(prompt || "", /même type|ordre de grandeur|étape intermédiaire|exécution du code/i);
});

test("la livraison complète prime sur le plafond interne après classement des meilleurs QCM", async () => {
  const { selectWithinTrivialBudget } = await import("../lib/qcm");
  const candidate = (stem: string, trivial: number[]) => ({
    ...item(1), stem, trivialDistractors: trivial.length ? trivial : null, verified: 1 as const,
  });
  const picked = selectWithinTrivialBudget([], [
    candidate("propre 1", []), candidate("propre 2", []), candidate("propre 3", []),
    candidate("toléré", [1]), candidate("de trop", [2]),
  ], 5);
  assert.deepEqual(picked.map((q) => q.stem), ["propre 1", "propre 2", "propre 3", "toléré", "de trop"]);
});

test("toutes les questions rejetées par les contrôles : l'échec le dit, sans parler de réponse illisible", async () => {
  contestKey = true;
  const error = await exam(await course(), 4).then(() => "", (e: Error) => e.message);
  // Banc du 04/11 : l'échec se disait « réponse illisible » alors que le modèle avait répondu.
  assert.doesNotMatch(error, /illisible|mal formées/, error);
  assert.match(error, /contrôles de qualité/, error);
});

test("banc du 04/11 : l'avancement bouge dès qu'un lot est conçu, sans attendre sa vérification (8 % pendant 3 à 5 min)", async () => {
  const { pcts } = await exam(await course(), 4);
  const verifying = pcts.find((x) => /Vérification à l'aveugle/.test(x.s));
  assert.ok(verifying && verifying.p > 8, `avancement pendant la première vérification : ${verifying?.p}`);
});

test("banc du 04/11 : seule une MAUVAISE option nomme une notion hors du cours — l'option est remplacée, la question gardée", async () => {
  third = FOREIGN;
  const { r, steps, items } = await exam(await course(), 4);
  assert.equal(r.count, 4, steps.join("\n"));
  assert.equal(designCalls, 1, "aucune question régénérée ni rejetée");
  assert.ok(!steps.some((s) => /QCM rejeté — hors cours/.test(s)), steps.join("\n"));
  for (const it of items) assert.ok(!it.options.includes(FOREIGN) && it.options.includes(NEW_DISTRACTOR), it.options.join(" | "));
  assert.match(repairPrompts[0], /notion étrangère au cours.*← À REMPLACER/);
});

test("un verdict du correcteur mal typé (clé en nombre) ne fait pas perdre le lot", async () => {
  scalarKey = true;
  third = "Une affirmation qui change une condition du cours.";
  const { r, steps } = await exam(await course(), 4);
  assert.equal(r.count, 4, steps.join("\n"));
  assert.ok(!steps.some((s) => /Lot QCM échoué/.test(s)), steps.join("\n"));
});

test("banc du 04/11 : tous les lots d'une ronde partent ensemble (15 QCM = 4 lots, le 4e attendait les 3 premiers, +7 min)", async () => {
  third = "Une affirmation qui change une condition du cours.";
  const saved = process.env.QCM_BATCH_CONCURRENCY;
  delete process.env.QCM_BATCH_CONCURRENCY;
  try {
    const { r, steps } = await exam(await course(), 15);
    assert.equal(r.count, 15, steps.join("\n"));
    const firstBuilt = steps.findIndex((s) => /QCM construits \+ vérifiés/.test(s));
    assert.equal(steps.slice(0, firstBuilt).filter((s) => /^Génération de \d+ QCM/.test(s)).length, 4, steps.slice(0, firstBuilt + 1).join("\n"));
  } finally {
    process.env.QCM_BATCH_CONCURRENCY = saved;
  }
});

test("distracteur trivial ET autre faiblesse — la version faible n'est jamais livrée", async () => {
  // CS-290 15 QCM, tous les correctifs précédents : seuls 2 rejets, mais 6 QCM manquants au premier
  // tour — des questions régénérées pour une autre faiblesse, puis jetées pour un distracteur encore signalé.
  nameOnly = true;
  const result = await exam(await course(), 4).then((x) => ({ ...x, error: "" }), (e: Error) => ({ r: null, steps: [] as string[], items: [], error: e.message }));
  if (result.r) {
    assert.ok(result.items.every((it) => !it.options.some((o) => o.startsWith("Une option absurde"))), result.steps.join("\n"));
  } else {
    assert.match(result.error, /contrôles de qualité/, result.error);
  }
});

test("le remplacement des distracteurs voit les extraits du cours (distracteurs bâtis sur des notions voisines, pas inventés)", async () => {
  await exam(await course(), 4);
  assert.match(repairPrompts[0], /EXTRAITS DU COURS[\s\S]*impact disparate/i, repairPrompts[0].slice(0, 600));
});
