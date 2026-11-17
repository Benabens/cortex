/**
 * UN FAIT PAR QUESTION, DE BOUT EN BOUT — examen QCM #14 d'un cours de sciences humaines
 * (15/11/2026) : 20 questions pour une quinzaine de notions, et encore deux ou trois paires qui
 * testaient la même règle sous deux scénarios (la motivation, pendant du leadership ; des données
 * hébergées en Suisse sous une loi étrangère ; le nudge qui garde le choix).
 *
 * Rejeu simulé d'un cours inventé de 15 notions (fournisseur openai-compatible simulé : aucune
 * dépense). Le cours répète, dans trois autres chapitres, les trois propositions de l'examen #14 ;
 * le concepteur simulé dérive deux fois : une question reprend la clé d'une autre (seul le contrôle
 * des doublons du modèle le voit), une autre cite le passage d'un autre fait. Verrouillé :
 *  - 20/20, aucun fait partagé, au moins 10 notions, chaque proposition de l'examen #14 une seule fois ;
 *  - les deux dérives remplacées par des faits de réserve, sans faire tomber le compte ;
 *  - pas plus d'appels qu'une conception par notion (QCM_FACTS=0) hors extraction, faite une fois par cours ;
 *  - faits gardés en base : l'examen suivant ne les ré-extrait pas, et préfère les faits jamais posés,
 *    y compris ceux d'examens d'avant les faits (rattachés par leur contenu) ;
 *  - extraction en échec : l'examen se conçoit par notion, comme avant, sans erreur.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-faits-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
process.env.MAX_COURSES_PER_USER = "unlimited";
process.env.QCM_FACTS = "1";

/** Préfixe de la bonne réponse, sans ponctuation (aucune « notion de bonne réponse » commune à toutes). */
const KEY = "Il est exact que";
const FIXABLE = "Une option absurde réparable";

// ---------- Le cours inventé ----------
const C = "bcdfghjklmnpqrstvwxz";
const V = "aeiou";
/** Mot inventé propre au fait (i, j), k-ième ; aucune racine commune entre deux faits. */
const w = (i: number, j: number, k: number) => `${C[i]}${V[j]}${C[k + 5]}${V[(i + k) % 5]}lunde`;
const name = (i: number) => `${C[i]}a${C[(i + 1) % C.length]}orine`.replace(/^./, (c) => c.toUpperCase());
type Fact = { statement: string; passage: string };
const pseudo = (i: number, j: number): Fact => {
  const s = `Le ${w(i, j, 0)} a le ${w(i, j, 1)}, si le ${w(i, j, 2)} est au ${w(i, j, 3)}.`;
  return { statement: s, passage: s };
};
/** Les trois propositions de l'examen #14, paraphrasées, et leur rappel dans un autre chapitre. */
const THEMES: { label: string; fact: Fact; echo: { notion: number; fact: Fact }; marker: RegExp }[] = [
  {
    label: "Leadership et motivation",
    fact: { statement: "La motivation des équipes est le pendant direct du leadership.", passage: "Le cours présente la motivation des équipes comme le pendant direct du leadership." },
    echo: { notion: 7, fact: { statement: "Le leadership a pour pendant direct la motivation des équipes.", passage: "Rappel : le leadership a pour pendant direct la motivation des équipes." } },
    marker: /pendant direct/,
  },
  {
    label: "Souveraineté des données",
    fact: { statement: "Des données hébergées en Suisse restent soumises à une loi étrangère extraterritoriale, ce qui compromet la souveraineté.", passage: "Un hébergement en Suisse ne protège pas des lois étrangères extraterritoriales : la souveraineté des données reste compromise." },
    echo: { notion: 11, fact: { statement: "Même stockées en Suisse, des données exposées à une loi étrangère à portée extraterritoriale voient leur souveraineté compromise.", passage: "Le stockage en Suisse ne suffit pas : une loi étrangère extraterritoriale compromet la souveraineté des données." } },
    marker: /extraterritoriale/,
  },
  {
    label: "Architecture du choix",
    fact: { statement: "Un nudge modifie l'option par défaut sans supprimer le choix.", passage: "Le nudge modifie l'option par défaut sans jamais supprimer le choix de la personne." },
    echo: { notion: 13, fact: { statement: "Changer l'option par défaut tout en laissant le choix ouvert est un nudge.", passage: "Le nudge modifie l'option par défaut sans jamais supprimer le choix de la personne." } },
    marker: /option par défaut/,
  },
];
const NOTIONS = 15;
const label = (i: number) => (i < THEMES.length ? THEMES[i].label : `Notion ${name(i)}`);
/** Faits du cours par notion (le rappel d'un autre chapitre en tête, comme l'extraction simulée le rend). */
const factsOf = (i: number): Fact[] => {
  const own = Array.from({ length: 4 }, (_, j) => (i < THEMES.length && j === 0 ? THEMES[i].fact : pseudo(i, j)));
  const echo = THEMES.find((t) => t.echo.notion === i);
  return echo ? [echo.echo.fact, ...own] : own;
};
const textOf = (i: number) => `${i < THEMES.length ? THEMES[i].label : name(i)} : ${factsOf(i).map((f) => f.passage).join(" ")}`;
/** Fait (notion, rang) d'un énoncé. */
const where = new Map<string, [number, number]>();
for (let i = 0; i < NOTIONS; i++) factsOf(i).forEach((f, j) => where.set(f.statement, [i, j - (THEMES.some((t) => t.echo.notion === i) ? 1 : 0)]));
const DRIFT_KEY: [number, number] = [3, 1]; // reprend la clé du fait (3, 0) : seul le contrôle du modèle le voit
const DRIFT_SOURCE: [number, number] = [4, 1]; // cite le passage du fait (4, 0)

// ---------- Le fournisseur simulé ----------
/** `perNotion` : faits rendus par notion à l'extraction (0 = ce que demande le prompt). */
const sim = { factsFail: false, rejectEvery: 9, split: false, offCourse: 0, misfile: false, perNotion: 0 };
/**
 * Examen #16 (16/11), Q8 : un fait d'une notion rangé sous une autre à l'extraction (son passage était
 * dans les extraits de celle-ci). `sim.misfile` : le 3e fait de la notion 9 sort en tête de la notion 8,
 * et le cours de la notion 8 contient son passage.
 */
const MISFILED = { from: 9, to: 8, fact: () => pseudo(9, 2) };
let designed = 0;
const calls = { facts: 0, design: 0, verify: 0, repair: 0, audit: 0, dedup: 0, other: 0 };
const total = () => Object.values(calls).reduce((a, b) => a + b, 0);

function extract(prompt: string): string {
  if (sim.factsFail) return "pas du JSON";
  const k = sim.perNotion || Number(/Au plus (\d+) faits par notion/.exec(prompt)?.[1] ?? 4);
  const notions = [...prompt.matchAll(/^N(\d+)\. (.+)$/gm)].map((m) => ({ n: Number(m[1]), i: Array.from({ length: NOTIONS }, (_, i) => i).find((i) => label(i) === m[2].trim()) ?? -1 }));
  const facts = notions.filter((x) => x.i >= 0).flatMap(({ n, i }) => factsOf(i).slice(0, k).map((f) => ({ notion: n, statement: f.statement, passage: f.passage })));
  const to = notions.find((x) => x.i === MISFILED.to);
  if (!sim.misfile || !to) return JSON.stringify({ facts });
  const m = MISFILED.fact();
  const rest = facts.filter((f) => f.statement !== m.statement);
  const at = rest.findIndex((f) => f.notion === to.n);
  return JSON.stringify({ facts: [...rest.slice(0, at), { notion: to.n, statement: m.statement, passage: m.passage }, ...rest.slice(at)] });
}

function design(prompt: string): string {
  const lines = [...prompt.matchAll(/^ {2}(\d+)\) (.+)$/gm)].map((m) => m[2]);
  const n = Number(/\((\d+) QCM\)/.exec(prompt)?.[1] ?? 1);
  return JSON.stringify({ items: Array.from({ length: n }, (_, k) => {
    const g = ++designed;
    const line = lines[k] ?? "";
    const factM = /^(.+?) — FAIT À TESTER \[(f-[0-9a-f]+)\] : (.+?)$/.exec(line);
    const topic = (factM?.[1] ?? line.replace(/ \[.*$/, "").replace(/ — .*$/, "")).trim();
    let key: string;
    let source: string;
    let factIdOut = "";
    if (factM) {
      factIdOut = factM[2];
      const [i, j] = where.get(factM[3].trim()) ?? [-1, -1];
      key = `${KEY} ${factM[3].trim()}`;
      source = factsOf(i)[j + (THEMES.some((t) => t.echo.notion === i) ? 1 : 0)]?.passage ?? "";
      if (i === DRIFT_KEY[0] && j === DRIFT_KEY[1]) key = `${KEY} ${pseudo(i, 0).statement}`;
      if (i === DRIFT_SOURCE[0] && j === DRIFT_SOURCE[1]) source = pseudo(i, 0).passage;
    } else {
      // Conception par notion : la seconde question d'une notion reprend la règle centrale pour 3 et 4
      // (les paires de l'examen #14), un autre angle sinon.
      const i = Array.from({ length: NOTIONS }, (_, x) => x).find((x) => label(x) === topic) ?? -1;
      const seen = (seenTopics.get(topic) ?? 0) + 1;
      seenTopics.set(topic, seen);
      key = i === 3 || i === 4 ? `${KEY} la règle centrale de ${topic} tient` : `${KEY} ${topic} tient selon l'angle ${seen}`;
      source = i >= 0 ? factsOf(i)[0].passage : "";
    }
    const third = g % 3 === 0 ? `${FIXABLE} n°${g}.` : `Une affirmation proche du cours, fausse à une condition près (${g}).`;
    const options = [key, `Une affirmation inversée par rapport au cours (${g}).`, third, `Une affirmation attribuée à la mauvaise étude (${g}).`];
    return {
      topic, type: "scq", stem: `Question ${g} : que dit le cours sur ${topic} (cas ${g}) ?`,
      options, correct: [0], misconceptions: options.map((_, x) => (x ? "[mauvaise condition] x" : "")),
      explanation: "La bonne réponse reprend le cours ; les autres changent une condition ou l'attribution.",
      source_fact: source, ...(factIdOut ? { fact_id: factIdOut } : {}),
    };
  }) });
}
const seenTopics = new Map<string, number>();

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
    distractors: [...body.matchAll(/^\s+\((\d+)\) (.*?)\s+← À REMPLACER/gm)].map((x) => ({ option: Number(x[1]), text: `Une affirmation voisine du cours, réparée (${x[1]}-${index}).`, misconception: "[mauvaise condition] x" })),
    explanation: "La bonne réponse reprend le cours ; les autres changent une condition ou l'attribution.",
  })) });
}

/** Passage du cours qui établit l'énoncé d'un fait. */
const passageOf = new Map<string, string>();
for (let i = 0; i < NOTIONS; i++) for (const f of factsOf(i)) passageOf.set(f.statement, f.passage);

/** Audit final ; cours découpé (`sim.split`) : hors cours si la preuve de la clé manque aux extraits fournis. */
function audit(prompt: string): string {
  const extracts = prompt.split(/^Q0\./m)[0];
  return JSON.stringify({ verdicts: blocks(prompt).map(({ index, body }) => {
    const key = [...body.matchAll(/^\s+\((\d+)\) (.*)$/gm)].find((m) => m[2].startsWith(KEY))?.[2].slice(KEY.length).trim() ?? "";
    const proof = passageOf.get(key);
    const offCourse = sim.split && !!proof && !extracts.includes(proof);
    if (offCourse) sim.offCourse++;
    return { index, key: true, offCourse, trivial: trivialIdx(body) };
  }) });
}

/**
 * Contrôle des doublons du modèle : deux questions de même bonne réponse sont un doublon. Avec la
 * liste du programme, il nomme la notion dont relève la clé (celle du fait qu'elle énonce).
 */
function dedup(prompt: string): string {
  const first = new Map<string, number>();
  const duplicates: { first: number; second: number; reason: string }[] = [];
  const programme = new Map([...prompt.matchAll(/^N(\d+)\. (.+)$/gm)].map((m) => [m[2].trim(), Number(m[1])]));
  const notions: { index: number; notion: string; angle: string; regle: string; programme: number }[] = [];
  for (const { index, body } of blocks(prompt)) {
    // Revue finale : la clé est donnée par son rang (« CLÉ : 0 »), le texte est celui de l'option.
    const rank = /^\s+CLÉ : (\d+)/m.exec(body)?.[1];
    const key = (rank != null ? new RegExp(`^\\s+\\(${rank}\\) (.*)$`, "m").exec(body)?.[1] : /^\s+Bonne réponse : (.*)$/m.exec(body)?.[1])?.trim() ?? "";
    if (!key) continue;
    if (first.has(key)) duplicates.push({ first: first.get(key)!, second: index, reason: "même règle" });
    else first.set(key, index);
    const i = where.get(key.slice(KEY.length).trim())?.[0];
    if (sim.misfile && i !== undefined) notions.push({ index, notion: "", angle: "", regle: "", programme: programme.get(label(i)) ?? 0 });
  }
  return JSON.stringify({ notions, duplicates, repeats: [] });
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
      if (/\{"facts":/.test(content)) { calls.facts++; text = extract(content); }
      else if (/"replacements"/.test(content)) { calls.repair++; text = repair(content); }
      // Revue finale : audit (verdicts) et doublons dans le même appel.
      else if (/"duplicates"/.test(content) && /"offCourse"/.test(content)) { calls.dedup++; text = JSON.stringify({ ...JSON.parse(audit(content)), ...JSON.parse(dedup(content)) }); }
      else if (/"duplicates"/.test(content)) { calls.dedup++; text = dedup(content); }
      else if (/"offCourse"/.test(content)) { calls.audit++; text = audit(content); }
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
  Object.assign(sim, { factsFail: false, rejectEvery: 9, split: false, offCourse: 0, misfile: false, perNotion: 0 });
  designed = 0;
  seenTopics.clear();
  process.env.QCM_FACTS = "1";
});

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL", "MAX_COURSES_CREATED_PER_HOUR", "MAX_COURSES_PER_USER", "QCM_FACTS"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

let courseN = 0;
/** Le cours inventé ; `previous` : un examen d'avant les faits dont les questions testaient le premier fait de chaque notion. */
async function course(previous = false): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const row = buildCourseRow({ name: `Cours fictif faits ${++courseN}`, code: "FIC-114", language: "fr", examFormat: { kind: "qcm" } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics", "exams", "qcm_items"]) await q.ensureTable(t);
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", "Séances", "course_pdf/s1", null, 1);
    for (let i = 0; i < NOTIONS; i++) {
      // Découpé : un passage par fait, comme un vrai cours où une notion s'étale sur plusieurs pages.
      const texts = sim.split ? factsOf(i).map((f) => `${label(i)} : ${f.passage}`) : [textOf(i)];
      if (sim.misfile && i === MISFILED.to) texts[0] += ` ${MISFILED.fact().passage}`;
      for (const [k, text] of texts.entries()) {
        const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", `Séance ${i + 1}.${k + 1}`, text);
        await indexItemForSearch(iid, sid, `Séance ${i + 1}.${k + 1}`, text);
      }
      // Poids décroissants : l'ordre du programme est celui des notions.
      await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label(i), null, 30 - i, 1);
    }
    if (previous) {
      const examId = await q.insert(`INSERT INTO exams (format_template, status) VALUES ('qcm','ready')`);
      for (let i = 0; i < NOTIONS; i++) {
        const f = factsOf(i)[THEMES.some((t) => t.echo.notion === i) ? 1 : 0];
        await q.run(`INSERT INTO qcm_items (exam_id, idx, topic, type, stem, options_json, correct_json, misconceptions_json, explanation, verified) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          examId, i, label(i), "scq", `Question ancienne ${i} sur ${label(i)} ?`, JSON.stringify([f.statement, "Autre chose", "Encore autre chose", "Rien"]), "[0]", "[]", "", 1);
      }
    }
  });
  return row.id;
}

type Snapshot = import("../lib/qcm-checkpoint").QcmCheckpoint;

/** Point de reprise en mémoire : `saves` garde une copie de chaque écriture, dans l'ordre. */
function store(initial: unknown = null) {
  let current: unknown = initial;
  const saves: Snapshot[] = [];
  return {
    saves,
    load: async () => current,
    save: async (data: unknown) => {
      current = data;
      if (data) saves.push(JSON.parse(JSON.stringify(data)) as Snapshot);
    },
  };
}

async function generate(id: string, checkpoint?: ReturnType<typeof store>) {
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  const { q } = await import("../db/q");
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k] = 0;
  const steps: string[] = [];
  const r = await runWithCourse(id, () => generateQcmExam({ count: 20, openCount: 0, checkpoint, onStep: (s) => steps.push(s) }));
  const items = (await runWithCourse(id, () => getQcmExam(r.id, true)))!.items as unknown as { topic: string; options: string[]; correct: number[]; verified: number | null; type: string }[];
  const rows = await runWithCourse(id, () => q.all<{ fact_id: string | null; topic: string }>(`SELECT fact_id, topic FROM qcm_items WHERE exam_id = ? ORDER BY idx`, r.id));
  const facts = await runWithCourse(id, () => q.all<{ id: string; statement: string }>(`SELECT id, statement FROM course_facts ORDER BY seq`).catch(() => []));
  const detail = `${r.count}/20 · ${total()} appels ${JSON.stringify(calls)}\n${steps.filter((s) => !/^Génération de|^Vérification à/.test(s)).join("\n")}`;
  return { r, items, rows, facts, steps, calls: { ...calls, total: total() }, detail };
}

function assertDeliverable(items: { options: string[]; correct: number[]; verified: number | null; type: string }[], detail: string) {
  for (const it of items) {
    assert.equal(it.verified, 1, `aucune question non vérifiée : ${detail}`);
    assert.ok(it.options[it.correct[0]].startsWith(KEY), `jamais une clé fausse : ${detail}`);
    if (it.type === "scq") assert.equal(it.options.length, 4, `4 options : ${detail}`);
  }
}

test("examen #14 rejoué : 20/20, aucun fait partagé, ≥ 10 notions, chaque proposition une seule fois, sans plus d'appels", async (t) => {
  const id = await course();
  const after = await generate(id);
  t.diagnostic(`par faits : ${after.detail}`);
  assert.equal(after.r.count, 20, after.detail);
  assertDeliverable(after.items, after.detail);
  const ids = after.rows.map((r) => r.fact_id);
  assert.ok(ids.every(Boolean), `chaque question porte son fait : ${after.detail}`);
  assert.equal(new Set(ids).size, 20, `aucun fait partagé : ${ids.join(", ")}`);
  const notions = new Set(after.rows.map((r) => r.topic));
  assert.ok(notions.size >= 10, `${notions.size} notions : ${after.detail}`);
  // Les trois propositions de l'examen #14 : un seul fait chacune (le rappel d'un autre chapitre fusionné).
  for (const th of THEMES) {
    const same = after.facts.filter((f) => th.marker.test(f.statement));
    assert.equal(same.length, 1, `« ${th.fact.statement} » : un seul fait (${same.map((f) => f.statement).join(" / ")})`);
    assert.ok(ids.filter((x) => x === same[0].id).length <= 1);
  }
  // Les deux dérives du concepteur : ni deux bonnes réponses identiques, ni la question au passage d'un autre fait.
  const keys = after.items.map((it) => it.options[it.correct[0]]);
  assert.equal(new Set(keys).size, 20, `aucune bonne réponse en double : ${after.detail}`);
  assert.ok(after.steps.some((s) => /Faits testables : 20 faits distincts sur 15 notions/.test(s)), after.detail);

  // AVANT : la même composition conçue par notion, sur le même cours (sans faits).
  process.env.QCM_FACTS = "0";
  designed = 0;
  seenTopics.clear();
  const before = await generate(await course());
  t.diagnostic(`par notion : ${before.detail}`);
  t.diagnostic(`appels : par notion ${before.calls.total}, par faits ${after.calls.total} (dont ${after.calls.facts} d'extraction)`);
  // Conception en lots de 8 (neuf appels pour 20 QCM, par notion comme par faits) : l'extraction,
  // faite une fois par cours puis lue en base, n'est plus absorbée par des rondes économisées.
  assert.ok(after.calls.total - after.calls.facts <= before.calls.total, `pas plus d'appels hors extraction : ${after.calls.total - after.calls.facts} contre ${before.calls.total}`);
});

test("faits gardés en base : l'examen suivant ne ré-extrait rien et ne repose aucun fait déjà posé", async (t) => {
  const id = await course();
  const first = await generate(id);
  assert.equal(first.r.count, 20, first.detail);
  assert.ok(first.calls.facts > 0);
  const second = await generate(id);
  t.diagnostic(second.detail);
  assert.equal(second.calls.facts, 0, `faits lus en base : ${second.detail}`);
  assert.equal(second.r.count, 20, second.detail);
  const asked = new Set(first.rows.map((r) => r.fact_id));
  const again = second.rows.filter((r) => asked.has(r.fact_id));
  assert.equal(again.length, 0, `40 faits de réserve : aucun fait du premier examen reposé (${again.length})`);
});

test("examen d'avant les faits : ses questions sont rattachées à leur fait, que le nouvel examen ne repose pas", async (t) => {
  const { r, rows, facts, detail } = await generate(await course(true));
  t.diagnostic(detail);
  assert.equal(r.count, 20, detail);
  const firstOfEach = new Set(Array.from({ length: NOTIONS }, (_, i) => factsOf(i)[THEMES.some((th) => th.echo.notion === i) ? 1 : 0].statement));
  const reposed = rows.filter((row) => firstOfEach.has(facts.find((f) => f.id === row.fact_id)?.statement ?? ""));
  assert.equal(reposed.length, 0, `aucun fait déjà posé quand le cours en a de neufs : ${reposed.map((x) => x.topic).join(", ")}`);
});

test("extraction en échec : l'examen se conçoit par notion, comme avant, sans erreur", async (t) => {
  sim.factsFail = true;
  const { r, items, rows, steps, detail } = await generate(await course());
  t.diagnostic(detail);
  assert.equal(r.count, 20, detail);
  assertDeliverable(items, detail);
  assert.ok(rows.every((row) => !row.fact_id), "aucun fait");
  assert.ok(steps.some((s) => /conception par notion/.test(s)), detail);
});

test("hum-285 du 17/11 : moins de faits que de questions — les faits servent quand même, la conception par notion ne comble que le manque", async (t) => {
  // Un fait par notion : 15 faits (dont des rappels proches) pour 20 questions. Avant : tout
  // l'examen repassait par notion (11 paires de doublons au banc, 15/20 livrées).
  sim.perNotion = 1;
  const { r, rows, steps, detail } = await generate(await course());
  t.diagnostic(detail);
  assert.equal(r.count, 20, detail);
  assert.ok(!steps.some((s) => /trop peu → conception par notion/.test(s)), detail);
  // 15 faits, dont 3 rappels trop proches d'un autre : 12 faits au plan, 8 places par notion.
  assert.ok(steps.some((s) => /12 faits distincts .*8 question\(s\) conçue\(s\) par notion/.test(s)), detail);
  const withFact = rows.filter((row) => row.fact_id);
  assert.ok(withFact.length >= 10, `les faits du plan sont posés (${withFact.length}) : ${detail}`);
  assert.equal(new Set(withFact.map((row) => row.fact_id)).size, withFact.length, `aucun fait partagé : ${detail}`);
});

test("reprise après coupure : les faits du plan et ceux déjà donnés sont repris, sans nouvelle extraction ni fait partagé", async (t) => {
  const id = await course();
  const first = store();
  const run1 = await generate(id, first);
  assert.equal(run1.r.count, 20, run1.detail);
  const cut = first.saves.find((s) => s.designed && s.designed.items.some(Boolean) && s.designed.items.some((x) => !x));
  assert.ok(cut, `point de reprise en cours de conception : ${JSON.stringify(first.saves.map((s) => s.designed?.items.map(Boolean)))}`);
  assert.ok(cut.plan.facts?.length && cut.designed!.usedFacts?.length, "le plan garde ses faits, la réserve ceux déjà donnés");
  // La table des faits vidée : une reprise qui réextrairait se verrait.
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  await runWithCourse(id, () => q.run(`DELETE FROM course_facts`));
  const run2 = await generate(id, store(cut));
  t.diagnostic(run2.detail);
  assert.equal(run2.calls.facts, 0, `faits repris du point de reprise : ${run2.detail}`);
  assert.equal(run2.r.count, 20, run2.detail);
  const ids = run2.rows.map((r) => r.fact_id);
  assert.ok(ids.every(Boolean) && new Set(ids).size === 20, `aucun fait partagé : ${ids.join(", ")}`);
  assert.ok(run2.steps.some((s) => /Reprise après interruption/.test(s)), run2.detail);
});

test("notion étalée sur plusieurs pages : l'audit final voit la preuve du fait de chaque question, rien n'est jugé hors cours à tort", async (t) => {
  sim.split = true;
  const { r, items, rows, steps, detail } = await generate(await course());
  t.diagnostic(`${detail}\naudit : ${sim.offCourse} hors cours`);
  assert.ok(rows.every((row) => !!row.fact_id), `conçu par faits : ${detail}`);
  assert.equal(r.count, 20, detail);
  assertDeliverable(items, detail);
  assert.equal(sim.offCourse, 0, `aucune question jugée hors cours faute de sa preuve : ${detail}`);
  assert.ok(!steps.some((s) => /complément final/.test(s)), `pas de complément final : ${detail}`);
});

test("examen #16, Q8 : un fait rangé sous une autre notion à l'extraction — l'étiquette suit la notion que la question teste", async (t) => {
  // Aucune clé contestée : la question du fait mal rangé ne doit pas tomber par hasard à la vérification.
  Object.assign(sim, { misfile: true, rejectEvery: 0 });
  const { r, rows, facts, steps, detail } = await generate(await course());
  t.diagnostic(detail);
  assert.equal(r.count, 20, detail);
  const misfiled = facts.find((f) => f.statement === MISFILED.fact().statement);
  assert.ok(misfiled, `le fait mal rangé est extrait : ${detail}`);
  const row = rows.find((x) => x.fact_id === misfiled.id);
  assert.ok(row, `une question teste le fait mal rangé (en tête de sa notion) : ${rows.map((x) => x.topic).join(", ")}`);
  assert.equal(row.topic, label(MISFILED.from), "étiquette : la notion dont parle le fait, pas celle sous laquelle il était rangé");
  assert.ok(steps.some((s) => /étiquette\(s\) de notion recalée/.test(s)), detail);
  // Les autres questions gardent l'étiquette de leur fait.
  assert.ok(rows.filter((x) => x !== row).every((x) => x.topic !== label(MISFILED.from) || facts.some((f) => f.id === x.fact_id)), detail);
});
