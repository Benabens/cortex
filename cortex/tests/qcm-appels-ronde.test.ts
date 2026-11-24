/**
 * APPELS PAR QUESTION LIVRÉE — banc moteur du 13/11/2026 (rs-qcm15, codex-cli) : 12 QCM livrés sur
 * 15, 50 appels enregistrés dont 23 vérifications et 12 réparations de distracteurs, 32 min. Chaque
 * lot de 4 enchaînait seul conception → vérification → réparation → revérification, et chaque
 * ronde de comblement refaisait la même chaîne lot par lot.
 * Verrouillé, sur un scénario simulé de la même forme (15 QCM, un tiers des questions avec un
 * distracteur trivial, une sur cinq à clé contestée) : réparations et vérifications regroupées par
 * ronde, arrêt anticipé d'un lot déjà bon, et une question écartée toujours remplacée tant que le
 * budget le permet — l'audit final et le dédoublonnage ne font jamais tomber la livraison.
 * Fournisseur LLM simulé (openai-compatible) : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-appels-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
process.env.MAX_COURSES_PER_USER = "unlimited";

const KEY = "Une affirmation juste, tirée du cours.";
const TRIVIAL = "Une option absurde que tout étudiant élimine.";
const GOOD = "Une affirmation proche du cours, fausse à une condition près.";
/** Remplaçant encore jugé éliminable : le correcteur et l'audit le signalent comme TRIVIAL. */
const RESIDUE = "Une option encore éliminable après réparation.";

/** Rang global de chaque QCM conçu : il fixe ses défauts, quel que soit le lot qui le porte. */
let designed = 0;
/** Défauts des QCM conçus : distracteur trivial, clé contestée (le correcteur trouve une autre option). */
let trivialEvery = 3;
let contestedEvery = 5;
/** Verdict « clé fausse » de l'audit final, par énoncé (vide : tout passe). */
let auditRejects: (stem: string, call: number) => boolean = () => false;
/** Énoncé réparé que rend l'audit final pour une clé refusée (hypothèse écrite), par énoncé. */
let auditFix: (stem: string) => string | undefined = () => undefined;
/** Prompts de la revue finale. */
const reviewPrompts: string[] = [];
/** L'audit final répond hors format (aucun verdict lisible). */
let auditUnreadable = false;
/** Paires en doublon rendues par le contrôle de fin d'examen, par appel. */
let dedupe: (call: number, prompt: string) => { first: number; second: number; reason: string }[] = () => [];
/** Un remplaçant sur `residueEvery` reste éliminable (0 : tous réussis). */
let residueEvery = 0;
/** Le correcteur relève une « définition différente » portée par un DISTRACTEUR, une question sur `mismatchEvery`. */
let mismatchEvery = 0;
let repaired = 0;
const calls = { design: 0, verify: 0, repair: 0, audit: 0, dedup: 0, review: 0, secondLook: 0, rewrite: 0, other: 0 };
/** Énoncés soumis à chaque passage de l'audit final. */
const auditedStems: string[][] = [];

function design(prompt: string): string {
  const subjects = [...prompt.matchAll(/^ {2}(\d+)\) (.+?)(?: \[|$)/gm)].map((m) => m[2].trim());
  const n = Number(/\((\d+) QCM\)/.exec(prompt)?.[1] ?? 1);
  return JSON.stringify({ items: Array.from({ length: n }, (_, i) => {
    const g = ++designed;
    const contested = contestedEvery > 0 && g % contestedEvery === 2;
    return {
      topic: subjects[i] ?? `Notion ${g}`, type: "scq",
      stem: `Question ${g} : que dit le cours sur ${subjects[i] ?? "la notion"} ?${contested ? " (variante B)" : ""}`,
      options: [KEY, "Une affirmation inversée par rapport au cours.", trivialEvery > 0 && g % trivialEvery === 0 ? TRIVIAL : GOOD, "Une affirmation attribuée à la mauvaise étude."],
      correct: [0], misconceptions: ["", "[inversion] x", "[mauvaise condition] x", "[mauvaise attribution] x"],
      explanation: "La bonne réponse reprend le cours ; l'inversion et la mauvaise attribution le déforment.",
      source_fact: "Équité des modèles, taux de faux positifs, impact disparate, modération de contenus.",
    };
  }) });
}

function blocks(prompt: string): { index: number; body: string }[] {
  return [...prompt.matchAll(/^Q(\d+)\.([\s\S]*?)(?=^Q\d+\.|$(?![\s\S]))/gm)].map((m) => ({ index: Number(m[1]), body: m[0] }));
}

function verify(prompt: string): string {
  return JSON.stringify({ results: blocks(prompt).map(({ index, body }) => {
    const opts = [...body.matchAll(/^\s+\((\d+)\) (.*)$/gm)];
    const key = Number(opts.find((m) => m[2].startsWith(KEY))?.[1] ?? 0);
    return {
      index, correct: [/\(variante B\)/.test(body) ? (key === 0 ? 1 : 0) : key], ok: true, discrimination: 4, name_only: false, issue: "",
      course_terms: [], off_course: "", off_course_terms: [], off_course_options: [], off_course_key: false, off_matter: "",
      trivial_distractors: opts.filter((m) => m[2].startsWith(TRIVIAL) || m[2].startsWith(RESIDUE)).map((m) => Number(m[1])),
      // HUM-285 (banc du 15/11) : « L'option 3 confond correction et prévention » — un distracteur
      // qui déforme une définition fait son rôle ; la clé, elle, est fidèle au cours.
      ...(mismatchEvery > 0 && index % mismatchEvery === 0
        ? { definition_mismatch: "L'option 3 confond « taux de faux positifs » et « impact disparate ».", definition_mismatch_key: false }
        : { definition_mismatch: "", definition_mismatch_key: false }),
    };
  }) });
}

function repair(prompt: string): string {
  return JSON.stringify({ replacements: blocks(prompt).map(({ index, body }) => ({
    index,
    distractors: [...body.matchAll(/^\s+\((\d+)\) .* ← À REMPLACER/gm)].map((x) => ({ option: Number(x[1]), text: residueEvery > 0 && ++repaired % residueEvery === 0 ? RESIDUE : GOOD, misconception: "[mauvaise condition] x" })),
    explanation: "La bonne réponse reprend le cours ; les autres changent une condition ou l'attribution.",
  })) });
}

function audit(prompt: string): string {
  return JSON.stringify({ verdicts: blocks(prompt).map(({ index, body }) => ({
    index, key: !auditRejects(body, calls.audit), offCourse: false, ...(auditRejects(body, calls.audit) && auditFix(body) ? { fix: auditFix(body) } : {}),
    trivial: [...body.matchAll(/^\s+\((\d+)\) (.*)$/gm)].filter((m) => m[2].startsWith(TRIVIAL) || m[2].startsWith(RESIDUE)).map((m) => Number(m[1])),
  })) });
}

function secondLook(prompt: string): string {
  return JSON.stringify({ second_look: blocks(prompt).map(({ index }) => ({ index, off_course: "", scope: "question" })) });
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
      if (/"second_look"/.test(content)) { calls.secondLook++; text = secondLook(content); }
      else if (/"explanations"/.test(content)) { calls.rewrite++; text = JSON.stringify({ explanations: [] }); }
      else if (/"replacements"/.test(content)) { calls.repair++; text = repair(content); }
      else if (/"duplicates"/.test(content) && /"offCourse"/.test(content)) {
        // Revue finale : audit et doublons dans le même appel.
        calls.review++;
        reviewPrompts.push(content);
        auditedStems.push(blocks(content).map((b) => b.body.split("\n")[0]));
        const verdicts = auditUnreadable ? "ok" : (JSON.parse(audit(content)) as { verdicts: unknown }).verdicts;
        text = JSON.stringify({ verdicts, notions: [], duplicates: dedupe(calls.review, content), repeats: [] });
      }
      else if (/"duplicates"/.test(content)) { calls.dedup++; text = JSON.stringify({ notions: [], duplicates: dedupe(calls.dedup, content) }); }
      else if (/"offCourse"/.test(content)) { calls.audit++; auditedStems.push(blocks(content).map((b) => b.body.split("\n")[0])); text = auditUnreadable ? JSON.stringify({ verdicts: "ok" }) : audit(content); }
      else if (/"results"/.test(content)) { calls.verify++; text = verify(content); }
      else if (/"items"/.test(content)) { calls.design++; text = design(content); }
      else calls.other++;
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
  designed = 0; trivialEvery = 3; contestedEvery = 5; residueEvery = 0; mismatchEvery = 0; repaired = 0;
  auditRejects = () => false; auditUnreadable = false; dedupe = () => []; auditFix = () => undefined; reviewPrompts.length = 0;
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k] = 0;
  auditedStems.length = 0;
});

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL", "MAX_COURSES_CREATED_PER_HOUR", "MAX_COURSES_PER_USER"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const NOTIONS = Array.from({ length: 24 }, (_, i) => `Notion fictive ${String.fromCharCode(65 + i)}`);

let courseN = 0;
async function course(): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const row = buildCourseRow({ name: `Cours fictif appels ${++courseN}`, code: "FIC-101", language: "fr", examFormat: { kind: "qcm" } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
    const text = "Équité des modèles, taux de faux positifs, impact disparate, modération de contenus.";
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", "Séances", "course_pdf/s1", null, 1);
    const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", "Séances", text);
    await indexItemForSearch(iid, sid, "Séances", text);
    for (const label of NOTIONS) await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, null, 3, 1);
  });
  return row.id;
}

async function exam(count: number) {
  const id = await course();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  const steps: string[] = [];
  return runWithCourse(id, async () => {
    const r = await generateQcmExam({ count, openCount: 0, onStep: (s) => { steps.push(s); } });
    return { r, steps, items: (await getQcmExam(r.id, true))!.items };
  });
}

const total = () => Object.values(calls).reduce((s, n) => s + n, 0);

test("rs-qcm15 simulé : 15/15 livrées, réparations et vérifications regroupées par ronde", async (t) => {
  const { r, steps } = await exam(15);
  const perDelivered = total() / Math.max(1, r.count);
  // Avant (lot par lot, même scénario) : 28 appels — design 8, verify 12, repair 5, audit 2, dedup 1.
  t.diagnostic(`${r.count}/15 livrées · ${JSON.stringify(calls)} → ${total()} appels, ${perDelivered.toFixed(2)} par question livrée`);
  const detail = `${JSON.stringify(calls)} → ${total()} appels, ${perDelivered.toFixed(2)} par question livrée\n${steps.join("\n")}`;
  assert.equal(r.count, 15, detail);
  assert.ok(calls.verify <= 4, `vérifications regroupées par ronde : ${detail}`);
  assert.ok(calls.repair <= 2, `réparations regroupées par ronde : ${detail}`);
  assert.ok(perDelivered <= 1.2, `appels par question livrée : ${detail}`);
});

test("audit final illisible : les QCM déjà vérifiés sont livrés, l'examen n'est pas perdu", async () => {
  contestedEvery = 0; trivialEvery = 0;
  auditUnreadable = true;
  const { r } = await exam(8);
  assert.equal(r.count, 8, JSON.stringify(calls));
});

test("audit final : une clé jugée fausse est remplacée, la livraison reste 15/15", async (t) => {
  contestedEvery = 0;
  // Le premier audit écarte deux questions déjà vérifiées ; le ré-audit les confirme absentes.
  auditRejects = (stem) => /Question (4|9) /.test(stem);
  const { r, items } = await exam(15);
  t.diagnostic(`${r.count}/15 livrées · ${JSON.stringify(calls)} → ${total()} appels`);
  assert.equal(r.count, 15, JSON.stringify(calls));
  assert.ok(!items.some((it) => /Question (4|9) /.test(it.stem)), "une clé fausse n'est jamais livrée");
});

test("dédoublonnage : un contrôle qui voit des doublons à chaque passe ne fait jamais tomber la livraison sous l'acquis", async (t) => {
  contestedEvery = 0; trivialEvery = 0;
  dedupe = () => [{ first: 0, second: 1, reason: "même notion" }, { first: 2, second: 3, reason: "même notion" }];
  const { r } = await exam(15);
  t.diagnostic(`${r.count}/15 livrées · ${JSON.stringify(calls)} → ${total()} appels`);
  assert.equal(r.count, 15, JSON.stringify(calls));
  assert.ok(calls.dedup <= 10, `contrôles des doublons bornés : ${calls.dedup}`);
  // Job 17 (14/11) : l'audit final repassait sur tout le pool même quand aucun distracteur n'avait
  // été réparé (ici : 0). Une question n'est auditée qu'une fois : le second passage (job 23) ne
  // porte que sur les remplaçants des doublons, arrivés après le premier.
  assert.ok(calls.audit <= 2, `audit final : ${JSON.stringify(calls)}`);
  const seen = auditedStems.flat();
  assert.equal(new Set(seen).size, seen.length, `une question auditée deux fois : ${JSON.stringify(auditedStems)}`);
});

test("HUM-285 simulé (20 QCM, banc du 15/11) : au plus 8 appels, 20/20 livrées", async (t) => {
  // La forme du run de référence (64 appels pour 20 QCM livrés) : 17 questions sur 20 avec un
  // distracteur jugé trivial, un remplaçant sur deux encore éliminable, une clé contestée sur vingt,
  // et une « définition différente » relevée sur un distracteur dans presque toutes les questions.
  trivialEvery = 1; residueEvery = 2; contestedEvery = 20; mismatchEvery = 1;
  const { r, steps } = await exam(20);
  const detail = `${JSON.stringify(calls)} → ${total()} appels\n${steps.join("\n")}`;
  t.diagnostic(`${r.count}/20 livrées · ${JSON.stringify(calls)} → ${total()} appels`);
  assert.equal(r.count, 20, detail);
  assert.ok(total() <= 8, `appels par examen de 20 QCM : ${detail}`);
  // Le distracteur qui déforme une définition fait son rôle : pas de second regard pour lui.
  assert.equal(calls.secondLook, 0, detail);
});

test("audit final : clé juste sous une hypothèse non écrite → énoncé réparé, livré seulement s'il est confirmé à l'aveugle", async (t) => {
  // Banc du 23/11/2026 (QCM ML, Opus 5.5) : clés justes « selon le cours » mais pas uniques pour un
  // expert (norme L1/L2 non dite, λ non chiffré). La revue réécrit l'énoncé avec l'hypothèse ;
  // la résolution à l'aveugle doit retrouver la clé, sinon la question part comme avant.
  contestedEvery = 0; trivialEvery = 0;
  auditRejects = (stem) => /Question (4|9) /.test(stem) && !/hypothèse écrite/.test(stem);
  auditFix = (stem) => {
    const head = /Question (\d+) : [^\n]*/.exec(stem)?.[0] ?? "";
    // Question 9 : la réécriture change la question (la résolution trouve une autre option).
    return /Question 9 /.test(head) ? `${head} (hypothèse écrite : vecteurs normalisés en norme L2) (variante B)` : `${head} (hypothèse écrite : vecteurs normalisés en norme L2)`;
  };
  const { r, items } = await exam(15);
  t.diagnostic(`${r.count}/15 livrées · ${JSON.stringify(calls)} → ${total()} appels`);
  assert.match(reviewPrompts[0] ?? "", /expert de la matière qui n'a pas suivi ce cours/, "l'audit juge aussi hors du cours");
  assert.equal(r.count, 15, JSON.stringify(calls));
  const q4 = items.filter((it) => /Question 4 /.test(it.stem));
  assert.equal(q4.length, 1, "la question 4 réparée est livrée");
  assert.match(q4[0].stem, /hypothèse écrite/, "sous son énoncé réparé");
  assert.ok(!items.some((it) => /Question 9 /.test(it.stem)), "une réparation que la résolution à l'aveugle contredit n'est jamais livrée");
  assert.ok(!items.some((it) => /Question 4 /.test(it.stem) && !/hypothèse écrite/.test(it.stem)), "l'énoncé d'origine ne revient pas en réserve");
});
