/**
 * PHASE FINALE D'UN EXAMEN QCM — constat prod du 15/11/2026 (job 26, 20 QCM, 11e examen d'un cours) :
 * 9 QCM livrés sur 20 en 72 min, dont 40 min à 99 % sur « un distracteur reste éliminable sans le
 * cours (gardé en réserve) » ; une question à 5 options dans un examen à réponse unique.
 *
 * Cause (rejeu simulé, bisect bb1caf8 → cbf3b65) : 5aa29e8 élargit les reprises d'examens précédents
 * (« même fait, même règle… même reformulée ») ; sur un cours déjà couvert par dix examens, une bonne
 * part des questions et de leurs remplaçants en sont, et une reprise était retirée sans retour. Le
 * fournisseur simulé ci-dessous suit la CONSIGNE qu'il reçoit : consigne large et cours saturé, une
 * question reconnue comme reprise sur deux ou trois. Avant le correctif : 14/20 et ~95 appels, ou
 * 0/20 (« Aucun QCM généré ») quand tout est une reprise ; bb1caf8 : 20/20 en 16 appels.
 *
 * Verrouillé :
 *  - une reprise d'un examen précédent n'est retirée que si un remplaçant passe ; sinon elle garde sa place ;
 *  - le budget temps de la phase finale borne les rondes de remplacement (fournisseur qui ne répare jamais) ;
 *  - une question à réponse unique a exactement 4 options, sinon son sujet est redemandé.
 * Fournisseur LLM simulé (openai-compatible) : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-rondes-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
process.env.MAX_COURSES_PER_USER = "unlimited";

const KEY = "Une affirmation juste, tirée du cours.";
/** Distracteur éliminable que la réparation ne corrige jamais (il reste éliminable, reformulé). */
const STUBBORN = "Une option absurde récalcitrante";
/** Distracteur éliminable qu'une réparation corrige. */
const FIXABLE = "Une option absurde réparable";

const sim = {
  /** Une question conçue sur `stubbornEvery` a un distracteur récalcitrant (0 : aucune). */
  stubbornEvery: 4,
  fixableEvery: 3,
  /** Une question sur `rejectEvery` a sa clé contestée par la vérification à l'aveugle. */
  rejectEvery: 9,
  /** > 0 : une question sur n reconnue comme reprise ; < 0 : toutes sauf une sur |n| ; 0 : aucune. */
  repeatEvery: 0,
  /** Une question conçue sur `fiveOptionsEvery` a 5 options (0 : aucune). */
  fiveOptionsEvery: 0,
  delayMs: 0,
};
let designed = 0;
let repaired = 0;
const calls = { design: 0, verify: 0, repair: 0, audit: 0, dedup: 0, other: 0 };
const total = () => Object.values(calls).reduce((a, b) => a + b, 0);

function design(prompt: string): string {
  const subjects = [...prompt.matchAll(/^ {2}(\d+)\) (.+?)(?: \[|$)/gm)].map((m) => m[2].trim());
  const n = Number(/\((\d+) QCM\)/.exec(prompt)?.[1] ?? 1);
  return JSON.stringify({ items: Array.from({ length: n }, (_, i) => {
    const g = ++designed;
    const third = sim.stubbornEvery && g % sim.stubbornEvery === 0 ? `${STUBBORN} n°${g}.`
      : sim.fixableEvery && g % sim.fixableEvery === 0 ? `${FIXABLE} n°${g}.`
        : `Une affirmation proche du cours, fausse à une condition près (${g}).`;
    const options = [KEY, `Une affirmation inversée par rapport au cours (${g}).`, third, `Une affirmation attribuée à la mauvaise étude (${g}).`];
    if (sim.fiveOptionsEvery && g % sim.fiveOptionsEvery === 0) options.push(`Une affirmation qui généralise le cours à tort (${g}).`);
    return {
      topic: subjects[i] ?? `Notion ${g}`, type: "scq",
      stem: `Question ${g} : que dit le cours sur ${subjects[i] ?? "la notion"} (cas ${g}) ?`,
      options, correct: [0], misconceptions: options.map((_, k) => (k ? "[mauvaise condition] x" : "")),
      explanation: "La bonne réponse reprend le cours ; les autres changent une condition ou l'attribution.",
      source_fact: "Équité des modèles, taux de faux positifs, impact disparate, modération de contenus.",
    };
  }) });
}

function blocks(prompt: string): { index: number; body: string }[] {
  return [...prompt.matchAll(/^Q(\d+)\.([\s\S]*?)(?=^Q\d+\.|$(?![\s\S]))/gm)].map((m) => ({ index: Number(m[1]), body: m[0] }));
}
const trivialIdx = (body: string) => [...body.matchAll(/^\s+\((\d+)\) (.*)$/gm)].filter((m) => m[2].startsWith("Une option absurde")).map((m) => Number(m[1]));

function verify(prompt: string): string {
  return JSON.stringify({ results: blocks(prompt).map(({ index, body }) => {
    const opts = [...body.matchAll(/^\s+\((\d+)\) (.*)$/gm)];
    const key = Number(opts.find((m) => m[2].startsWith(KEY))?.[1] ?? 0);
    const g = Number(/cas (\d+)/.exec(body)?.[1] ?? 1);
    const reject = sim.rejectEvery > 0 && g % sim.rejectEvery === 0;
    return {
      index, correct: reject ? [(key + 1) % opts.length] : [key], ok: !reject, discrimination: 4, name_only: false, issue: reject ? "clé contestée" : "",
      course_terms: [], off_course: "", off_course_terms: [], off_course_options: [], off_course_key: false, off_matter: "",
      trivial_distractors: trivialIdx(body), definition_mismatch: "",
    };
  }) });
}

function repair(prompt: string): string {
  return JSON.stringify({ replacements: blocks(prompt).map(({ index, body }) => ({
    index,
    distractors: [...body.matchAll(/^\s+\((\d+)\) (.*?)\s+← À REMPLACER/gm)].map((x) => ({
      option: Number(x[1]),
      text: x[2].startsWith(STUBBORN) ? `${STUBBORN} n°r${++repaired}.` : `Une affirmation voisine du cours, réparée (${++repaired}).`,
      misconception: "[mauvaise condition] x",
    })),
    explanation: "La bonne réponse reprend le cours ; les autres changent une condition ou l'attribution.",
  })) });
}

function audit(prompt: string): string {
  return JSON.stringify({ verdicts: blocks(prompt).map(({ index, body }) => ({ index, key: true, offCourse: false, trivial: trivialIdx(body) })) });
}

/** Contrôle des doublons : aucun doublon interne ; les reprises suivent la consigne reçue (voir l'en-tête). */
function dedup(prompt: string): string {
  const broad = /même si la notion, l'angle ou le décor sont reformulés/.test(prompt);
  const previous = new Set([...prompt.matchAll(/^P\d+\. .*?sur (\S.*?) \(cas ancien/gm)].map((m) => m[1]));
  const n = sim.repeatEvery;
  const repeats = broad && n ? [...prompt.matchAll(/^Q(\d+)\. .*?sur (.+?) \(cas (\d+)\)/gm)]
    .filter((m) => previous.has(m[2]) && (n > 0 ? Number(m[3]) % n === 0 : Number(m[3]) % -n !== 0))
    .map((m) => ({ index: Number(m[1]), previous: 0 })) : [];
  return JSON.stringify({ notions: [], duplicates: [], repeats });
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
      if (/"replacements"/.test(content)) { calls.repair++; text = repair(content); }
      else if (/"duplicates"/.test(content)) { calls.dedup++; text = dedup(content); }
      else if (/"offCourse"/.test(content)) { calls.audit++; text = audit(content); }
      else if (/"results"/.test(content)) { calls.verify++; text = verify(content); }
      else if (/"items"/.test(content)) { calls.design++; text = design(content); }
      else calls.other++;
      const respond = () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
      };
      if (sim.delayMs > 0) setTimeout(respond, sim.delayMs); else respond();
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => {
  Object.assign(sim, { stubbornEvery: 4, fixableEvery: 3, rejectEvery: 9, repeatEvery: 0, fiveOptionsEvery: 0, delayMs: 0 });
  designed = 0;
  repaired = 0;
  delete process.env.QCM_FINAL_PHASE_BUDGET_MS;
});

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL", "MAX_COURSES_CREATED_PER_HOUR", "MAX_COURSES_PER_USER", "QCM_FINAL_PHASE_BUDGET_MS"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const NOTIONS = Array.from({ length: 21 }, (_, i) => `Notion fictive ${i + 1}`);

let courseN = 0;
/** Un cours fictif de 21 notions ; `previous` énoncés d'examens précédents qui couvrent déjà chaque notion. */
async function course(previous = 0): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const row = buildCourseRow({ name: `Cours fictif rondes finales ${++courseN}`, code: "FIC-102", language: "fr", examFormat: { kind: "qcm" } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics", "exams", "qcm_items"]) await q.ensureTable(t);
    const text = "Équité des modèles, taux de faux positifs, impact disparate, modération de contenus.";
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", "Séances", "course_pdf/s1", null, 1);
    const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", "Séances", text);
    await indexItemForSearch(iid, sid, "Séances", text);
    for (const label of NOTIONS) await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, null, 3, 1);
    if (previous) {
      const examId = await q.insert(`INSERT INTO exams (format_template, status) VALUES ('qcm','ready')`);
      const labels = [...NOTIONS, "Séances"];
      for (let j = 0; j < previous; j++) {
        const label = labels[j % labels.length];
        await q.run(`INSERT INTO qcm_items (exam_id, idx, topic, type, stem, options_json, correct_json, misconceptions_json, explanation, verified) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          examId, j, label, "scq", `Question ancienne ${j} : que dit le cours sur ${label} (cas ancien ${j}) ?`, "[]", "[0]", "[]", "", 1);
      }
    }
  });
  return row.id;
}

async function generate(id: string) {
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k] = 0;
  const steps: string[] = [];
  let finalStart = -1;
  const r = await runWithCourse(id, () => generateQcmExam({
    count: 20, openCount: 0,
    onStep: (s) => { steps.push(s); if (finalStart < 0 && s.startsWith("Dernière vérification de l'examen")) finalStart = total(); },
  }));
  const items = (await runWithCourse(id, () => getQcmExam(r.id, true)))!.items;
  const detail = `${r.count}/20 · ${total()} appels ${JSON.stringify(calls)}\n${steps.filter((s) => !/^Génération de|^Vérification à/.test(s)).join("\n")}`;
  return { r, items, steps, finalCalls: finalStart < 0 ? 0 : total() - finalStart, detail };
}

/** Items lus avec les clés (getQcmExam(…, true)) : `correct` présent, absent du type de la vue. */
function assertDeliverable(view: { type: string; options: string[]; verified?: number | null; rejected?: unknown }[], detail: string) {
  const items = view as (typeof view[number] & { correct: number[] })[];
  for (const it of items) {
    assert.equal(it.verified, 1, `aucune question non vérifiée : ${detail}`);
    assert.ok(!it.rejected, `aucune question rejetée : ${detail}`);
    assert.equal(it.options[it.correct[0]], KEY, `jamais une clé fausse : ${detail}`);
    if (it.type === "scq") assert.equal(it.options.length, 4, `réponse unique : 4 options exactement : ${detail}`);
  }
}

test("job 26 : cours déjà couvert par les examens précédents, reprises au sens large → 20/20, pas 14/20", async (t) => {
  sim.repeatEvery = -3; // deux questions sur trois reconnues comme reprises
  const { r, items, detail } = await generate(await course(60));
  t.diagnostic(detail);
  assert.equal(r.count, 20, `une reprise sans remplaçant garde sa place plutôt qu'un trou : ${detail}`);
  assertDeliverable(items, detail);
});

test("tout l'examen est une reprise d'examens précédents : livré quand même (avant : « Aucun QCM généré »)", async (t) => {
  sim.repeatEvery = 1;
  const { r, items, detail } = await generate(await course(60));
  t.diagnostic(detail);
  assert.equal(r.count, 20, detail);
  assertDeliverable(items, detail);
});

test("une reprise est remplacée quand un remplaçant passe : le cours sans examen précédent reste intact", async (t) => {
  sim.repeatEvery = 2;
  const { r, items, steps, detail } = await generate(await course(0));
  t.diagnostic(detail);
  assert.equal(r.count, 20, detail);
  assert.ok(!steps.some((s) => /proche\(s\) d'un examen précédent gardée/.test(s)), `aucune reprise sans examen précédent : ${detail}`);
  assertDeliverable(items, detail);
});

test("distracteur jamais réparé + reprises en série : le budget temps de la phase finale borne les rondes", async (t) => {
  // Le pire cas du job 26 : chaque remplaçant redevient une reprise, chaque réparation laisse un
  // distracteur éliminable. Un budget d'1 ms : aucune NOUVELLE ronde de remplacement après le
  // premier contrôle des doublons ; seuls les contrôles obligatoires de la porte de sortie passent.
  sim.repeatEvery = -3;
  sim.stubbornEvery = 2;
  sim.delayMs = 5;
  process.env.QCM_FINAL_PHASE_BUDGET_MS = "1";
  const { r, items, steps, finalCalls, detail } = await generate(await course(60));
  t.diagnostic(`phase finale : ${finalCalls} appels · ${detail}`);
  // Sans budget temps (cbf3b65) : ~80 appels après la fin du comblement principal (10 lots de remplacement).
  assert.ok(finalCalls <= 8, `phase finale bornée par son budget temps : ${finalCalls} appels · ${detail}`);
  assert.ok(steps.some((s) => s.includes("budget de la phase finale atteint")), `étape affichée honnête : ${detail}`);
  assert.equal(r.count, 20, `les questions déjà vérifiées sont gardées plutôt que remplacées : ${detail}`);
  assertDeliverable(items, detail);
});

test("job 26 : une question à 5 options dans un examen à réponse unique n'est jamais livrée", async (t) => {
  sim.fiveOptionsEvery = 5;
  const { r, items, steps, detail } = await generate(await course(0));
  t.diagnostic(detail);
  assert.ok(steps.some((s) => /à 5 options écarté/.test(s)), `le contrôle a vu les questions à 5 options : ${detail}`);
  assert.equal(r.count, 20, `leur sujet est redemandé : ${detail}`);
  assertDeliverable(items, detail);
});
