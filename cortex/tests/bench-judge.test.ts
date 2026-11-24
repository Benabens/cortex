/**
 * Juge du banc (lib/bench/judge) : le solveur répond sans la clé, l'arbitre tranche, le code
 * dont dépend une clé est exécuté et sa sortie fait foi ; les rejets « hors cours » sont
 * revus dans tout le cours. Fournisseur simulé (openai-compatible) : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { BenchRun } from "../lib/bench/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bench-judge-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";

const prompts: string[] = [];
/** Appels de l'arbitre à faire échouer (503) avant de répondre : panne passagère du fournisseur. */
let failAdjudicate = 0;
let llm: http.Server;

/** Réponse du faux modèle selon le rôle demandé par le juge. */
function reply(prompt: string): unknown {
  if (/Tu ne vois ni la clé/.test(prompt)) return { answers: [{ q: 0, chosen: [1] }, { q: 1, chosen: [0] }] };
  if (/examinateur exigeant/.test(prompt) && /BLOCS-SOUS-QUESTIONS/.test(prompt)) {
    const v = (q: number, off: boolean) => ({ q, key: "right", explanation: "consistent", definition: "conform", off_course: off, distractors: 3, trivial: [], chapter: 1, notion: `n${q}`, code: null, evidence: [] });
    // Banc rs-composite du 23/11 : un verdict par SOUS-question (q 0 à 3 pour deux questions de deux
    // sous-questions), le hors cours de la sous-question B de Q0 portant le numéro de Q1.
    return /ATTENTION \(essai/.test(prompt) ? { items: [v(0, false), v(1, false)] } : { items: [v(0, false), v(1, true), v(2, false), v(3, false)] };
  }
  if (/examinateur exigeant/.test(prompt)) {
    // Un verdict par question montrée (Q0 à Q3 pour l'examen QCM, Q0 seule pour l'exercice).
    const shown = (x: { q: number }) => new RegExp(`^Q${x.q} \\[`, "m").test(prompt);
    return {
      items: [
        // Indices hors bornes, non entiers ou en chaîne (sortie non garantie) : jamais comptés.
        { q: 0, key: "wrong", explanation: "consistent", definition: "na", off_course: false, distractors: 3, trivial: [3, 0, 7, 1.5, "2"], chapter: 1, notion: "ordre des segments", code: null, evidence: [{ criterion: "key", option: 0, source: "Cours", passage: "TCP ordonne" }] },
        { q: 1, key: "right", explanation: "consistent", definition: "na", off_course: false, distractors: 3, trivial: [], chapter: 99, notion: "somme", code: { language: "python", source: "print(2 + 2)", stdin: "", expected: "5" }, evidence: [{ criterion: "key", option: 1, source: "Question", passage: "2 + 2" }] },
        { q: 2, key: "right", explanation: "consistent", definition: "na", off_course: false, distractors: 3, trivial: [], chapter: 1, notion: "pandas", code: { language: "python", source: "import module_absent_du_banc\nprint(1)", stdin: "", expected: "1" }, evidence: [{ criterion: "key", option: 0, source: "Cours", passage: "première ligne" }] },
        { q: 3, key: "right", explanation: "consistent", definition: "na", off_course: false, distractors: 3, trivial: [], chapter: 1, notion: "randint", code: { language: "python", source: "import random\nstop = random.randint(2, 4)\nprint(list(range(2, stop)) + [stop])", stdin: "", expected: "[2], [2, 3], [2, 3, 4]" }, evidence: [{ criterion: "key", option: 3, source: "Question", passage: "randint inclut 4" }] },
      ].filter(shown),
    };
  }
  if (/doublons/.test(prompt)) return { intra: [[0, 1], [1, 1]], previous: [1] };
  if (/écarté ces questions/.test(prompt)) return { items: [{ q: 0, in_course: true }] };
  return {};
}

before(async () => {
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const prompt = String((JSON.parse(body).messages as { content: string }[]).at(-1)?.content);
      prompts.push(prompt);
      if (/examinateur exigeant/.test(prompt) && failAdjudicate > 0) {
        failAdjudicate--;
        res.statusCode = 503;
        res.end("{}");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply(prompt)) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = {
  exam: {
    id: 1, kind: "qcm", items: [
      { idx: 0, kind: "qcm", topic: "t", stem: "Quel protocole numérote les segments ?", options: ["TCP", "UDP", "IP", "ICMP"], correct: [0], explanation: "TCP numérote." },
      { idx: 1, kind: "qcm", topic: "t", stem: "Que vaut la sortie de print(2 + 2) ?", options: ["4", "5", "22", "Erreur"], correct: [1], explanation: "Elle affiche 5." },
      { idx: 2, kind: "qcm", topic: "t", stem: "Que vaut df.iloc[0] ?", options: ["1", "2", "3", "4"], correct: [0], explanation: "La première ligne vaut 1." },
      { idx: 3, kind: "qcm", topic: "t", stem: "Quelles listes finales sont possibles ?", options: ["[2, 2]", "[2]", "[2, 2], [2, 3, 3]", "[2], [2, 3], [2, 3, 4]"], correct: [3], explanation: "randint inclut 4, range exclut stop." },
    ],
  },
  plan: { chapters: [{ id: 1, seq: 1, title: "Transport" }, { id: 2, seq: 2, title: "Réseau" }], topicChapter: {} },
  previous: [{ stem: "Que vaut print(2 + 2) ?", topic: null }],
  rejected: [
    { stem: "Que garantit TCP ?", options: ["l'ordre", "rien"], correct: [0], reason: "hors cours : absent du cours : ordre" },
    { stem: "Explication par position", options: ["a", "b"], correct: [0], reason: "explication qui désigne une option par sa position ou sa lettre" },
  ],
} as unknown as BenchRun;

test("juge : arbitre, code exécuté, doublons et faux rejets ; la clé n'est jamais montrée au solveur", async () => {
  const { runWithCourse } = await import("../db/client");
  const { judgeExam } = await import("../lib/bench/judge");
  const { sandboxAvailable } = await import("../lib/sandbox-exec");
  const v = await runWithCourse("ml", () => judgeExam(run));

  const solverPrompt = prompts.find((p) => /Tu ne vois ni la clé/.test(p)) ?? "";
  assert.doesNotMatch(solverPrompt, /CLÉ|EXPLICATION|TCP numérote/);
  assert.match(prompts.find((p) => /examinateur exigeant/.test(p)) ?? "", /SOLVEUR INDÉPENDANT : 1/);

  assert.equal(v.items[0].key, "wrong");
  // L'indice 0 est la bonne réponse et les autres options n'ont aucun marqueur formel déterministe.
  assert.equal(v.items[0].trivialDistractors, 0);
  assert.equal(v.items[0].chapter, 1);
  assert.equal(v.items[1].chapter, null, "un chapitre hors du plan n'est pas retenu");
  if (sandboxAvailable()) {
    assert.deepEqual([v.items[1].code?.ran, v.items[1].code?.ok, v.items[1].key], [true, false, "wrong"], "la sortie réelle (4) contredit la clé (5)");
    // Un programme qui ne tourne pas ici (module absent) ne prouve rien contre la clé.
    assert.deepEqual([v.items[2].code?.ran, v.items[2].key], [false, "right"]);
    // Banc rs-mixte du 17/11 : un tirage aléatoire sans graine donne UNE sortie, pas l'ensemble des
    // sorties possibles que la clé énumère ; une seule exécution ne prouve rien contre elle.
    assert.deepEqual([v.items[3].code?.ran, v.items[3].key], [false, "right"]);
  }
  assert.deepEqual(v.duplicatesIntra, [[0, 1]]);
  assert.deepEqual(v.duplicatesPrevious, [1]);
  assert.deepEqual(v.rejected, [{ idx: 0, offCourseReject: true, falseRejection: true }, { idx: 1, offCourseReject: false, falseRejection: false }]);
  assert.match(v.rubric, /^v2:/);
});

test("chapitre : un rang rendu à la place de l'identifiant est rattaché ; un plan d'un seul chapitre est attribué d'office", async () => {
  const { chapterOf } = await import("../lib/bench/judge");
  const plan = [{ id: 1000019, seq: 1, title: "Fairness_1.md" }, { id: 1000020, seq: 2, title: "Safety_1.md" }];
  assert.equal(chapterOf(1000020, plan), 1000020);
  assert.equal(chapterOf(2, plan), 1000020, "le juge a rendu le rang du chapitre");
  assert.equal(chapterOf(7, plan), null);
  assert.equal(chapterOf(null, plan), null);
  assert.equal(chapterOf(null, [plan[0]]), 1000019, "un seul chapitre : toute question en relève");
  // CS-290 au banc : le juge rendait l'identifiant en chaîne (« "1000028" »), aucune question rattachée.
  assert.equal(chapterOf("1000020" as unknown as number, plan), 1000020);
  assert.equal(chapterOf("2" as unknown as number, plan), 1000020);
});

test("vote du juge : une option n'est retenue que si au moins deux arbitres sur trois la signalent", async () => {
  const { majorityOptions, majorityValue } = await import("../lib/bench/judge");
  assert.deepEqual(majorityOptions([[0, 1], [1, 2], [1, 3]]), [1]);
  assert.deepEqual(majorityOptions([[0], [1], [2]]), []);
  assert.equal(majorityValue(["right", "wrong", "wrong"]), "wrong");
  assert.equal(majorityValue(["right", "wrong", "unsure"]), "right", "égalité : verdict prudent et déterministe");
});

test("distracteurs triviaux : les marqueurs formels sont mesurés sans appel au modèle", async () => {
  const { deterministicTrivialOptions } = await import("../lib/bench/judge");
  const item = { options: ["Toujours, sans aucune exception", "Cela dépend de la condition", "Jamais", "Le cas étudié"], correct: [1] };
  assert.deepEqual(deterministicTrivialOptions(item), [0, 2]);
  assert.deepEqual(deterministicTrivialOptions({ ...item, correct: [0, 1] }), [2], "une option correcte n'est jamais un distracteur");
});

test("une panne passagère du fournisseur pendant le jugement est réessayée, le jugement n'est pas perdu", async () => {
  failAdjudicate = 1;
  const { runWithCourse } = await import("../db/client");
  const { judgeExam } = await import("../lib/bench/judge");
  const v = await runWithCourse("ml", () => judgeExam(run));
  assert.equal(failAdjudicate, 0, "la panne a bien eu lieu");
  assert.equal(v.items.length, run.exam?.items.length);
});

test("exercice au long corrigé : l'arbitre le lit jusqu'au bout", async () => {
  // Banc du 15/11/2026 (cs-202-ecrit) : corrigés de 3 500 à 6 600 caractères coupés à 2 500 pour
  // l'arbitre, qui notait « corrigé tronqué après 1.3 » et une clé fausse sur un corrigé complet.
  const { runWithCourse } = await import("../db/client");
  const { judgeExam } = await import("../lib/bench/judge");
  const solution = `${"\\subq{1.1}{Première partie} La réponse détaillée. ".repeat(140)}FIN-DU-CORRIGÉ-1.6`;
  const written = { ...run, exam: { id: 2, kind: "exercises", items: [{ idx: 0, kind: "exercise", topic: "t", stem: "\\subq{1.1}{…}{4} … \\subq{1.6}{…}{4} …", solution }] }, rejected: [] } as unknown as BenchRun;
  prompts.length = 0;
  await runWithCourse("ml", () => judgeExam(written));
  assert.ok(solution.length > 6000);
  assert.match(prompts.find((p) => /examinateur exigeant/.test(p)) ?? "", /FIN-DU-CORRIGÉ-1\.6/);
});

test("questions composées : un verdict rendu par sous-question est redemandé, jamais rangé sur la question du même numéro", async () => {
  // Banc rs-composite du 23/11 (offCourse.leaked = 1) : deux arbitres sur trois ont numéroté les
  // sous-questions (q 0 à 24 pour cinq questions) ; la sous-question (e) de Q1, hors cours pour eux,
  // portait le numéro de Q5, comptée « livrée hors cours ».
  const { runWithCourse } = await import("../db/client");
  const { judgeExam } = await import("../lib/bench/judge");
  const part = (prompt: string) => ({ kind: "scq", prompt, options: ["Deontology", "Utilitarianism", "Virtue ethics", "Care ethics"], correct: 0, explanation: "" });
  const blocks = {
    ...run,
    exam: { id: 3, kind: "blocks", items: [
      { idx: 0, kind: "block", topic: "Q1", stem: "BLOCS-SOUS-QUESTIONS HelperBot in the corridor.", parts: [part("Which theory?"), part("Which value notion?")] },
      { idx: 1, kind: "block", topic: "Q2", stem: "Lakeside admissions score.", parts: [part("Which parity?"), part("Which bias?")] },
    ] },
    rejected: [],
  } as unknown as BenchRun;
  const v = await runWithCourse("ml", () => judgeExam(blocks));
  assert.deepEqual(v.items.map((x) => [x.idx, x.offCourse, x.notion]), [[0, false, "n0"], [1, false, "n1"]]);
});

test("questions composées : l'arbitre voit les extraits du cours de chaque sous-question, pas seulement ceux du scénario", async () => {
  // Banc rs-composite du 24/11 (offCourse.leaked = 2) : extraits cherchés sur le seul scénario, et
  // coupés aux 900 premiers caractères d'un support de 6 000 ; Gorwa (position 4 033) et Deloitte,
  // cités par des sous-questions et présents dans le cours, jugés « absents des extraits ».
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const { judgeExam } = await import("../lib/bench/judge");
  const intro = Array.from({ length: 40 }, (_, i) => `Moderation goal ${i}: protect online communities while preserving expression.`).join(" ");
  const GORWA = `${intro} Gorwa taxonomy: classification (keywords, sentiment, machine learning) versus matching (perceptual hashing of known content).`;
  await runWithCourse("ml", async () => {
    ensureFts();
    for (const t of ["sources", "items"]) await q.ensureTable(t);
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "note", "Safety 1", "note/safety-1", null, 1);
    const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "note", "Safety 1", GORWA);
    await indexItemForSearch(iid, sid, "Safety 1", GORWA);
  });
  const blocks = {
    ...run,
    exam: { id: 4, kind: "blocks", items: [
      { idx: 0, kind: "block", topic: "Q1", stem: "A forum filters posts before publication.", parts: [
        { kind: "scq", prompt: "Under Gorwa's taxonomy, which approach does the filter use?", options: ["Classification", "Matching", "Pre-publication review", "Down-ranking"], correct: 0, explanation: "" },
      ] },
    ] },
    rejected: [],
  } as unknown as BenchRun;
  const from = prompts.length;
  await runWithCourse("ml", () => judgeExam(blocks));
  const adjudication = prompts.slice(from).find((p) => /examinateur exigeant/.test(p)) ?? "";
  assert.ok(adjudication.includes("perceptual hashing"), "l'extrait du cours cité par la sous-question manque à l'arbitre");
});

test("un verdict par question du lot : ni numéro étranger, ni question manquante, ni deux verdicts pour la même", async () => {
  const { verdictsCoverBatch } = await import("../lib/bench/judge");
  assert.equal(verdictsCoverBatch([{ q: 4 }, { q: 5 }], [4, 5]), null);
  assert.match(verdictsCoverBatch([{ q: 4 }, { q: 5 }, { q: 6 }], [4, 5]) ?? "", /un seul par question/, "numéro de sous-question");
  assert.notEqual(verdictsCoverBatch([{ q: 4 }], [4, 5]), null, "question manquante");
  // Deux verdicts pour Q4 : find() n'en garde qu'un, l'autre disparaît sans bruit.
  assert.notEqual(verdictsCoverBatch([{ q: 4 }, { q: 4 }, { q: 5 }], [4, 5]), null, "deux verdicts pour la même question");
  assert.notEqual(verdictsCoverBatch([{ q: "4" }, { q: 5 }], [4, 5]), null, "numéro en chaîne");
});
