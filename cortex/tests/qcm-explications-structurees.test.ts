/**
 * EXPLICATIONS COHÉRENTES PAR CONSTRUCTION — examen QCM #15 d'un cours de sciences humaines
 * (16/11/2026, job 30) : trois explications sur vingt réfutaient des options ABSENTES, malgré trois
 * rondes de contrôles lexicaux. Les trois cas, transposés dans un domaine inventé :
 *  - Q10 : l'explication réfute deux critères qu'aucune option ne nomme, à côté des vrais distracteurs ;
 *  - Q13 : quatre réfutations pour trois distracteurs (une « prohibition stricte » absente) ;
 *  - Q8 : une variante d'option réfutée, qu'aucune option ne porte (un distracteur remplacé).
 * Et une étiquette de notion qui n'est pas celle du fait testé (Q1).
 *
 * Unitaires (lib/qcm-rationale) puis rejeu simulé d'un cours inventé (fournisseur openai-compatible
 * simulé : aucune dépense), avant (QCM_STRUCTURED_EXPLANATIONS=0) et après.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-expl-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
process.env.MAX_COURSES_PER_USER = "unlimited";
process.env.QCM_FACTS = "1";

// ───────────────────────────── unitaires ─────────────────────────────

/** Q10, transposée : la clé (D) et trois distracteurs réels. */
const Q10 = {
  stem: "Selon le cours, quelles qualités un protocole de tri des glorbes doit-il réunir pour être adopté à grande échelle ?",
  options: [
    "Respecter les trois axiomes de Vandrel sur les glorbes isolés.",
    "Donner le même poids à chaque glorbe, même resté inactif.",
    "Marquer chaque glorbe d'un sceau numérique pour en prouver l'origine.",
    "Être simple à appliquer, fiable, et inspirer la confiance des trieurs.",
  ],
  correct: [3],
};

test("Q10 : la justification n'a de raison que pour les options réelles ; deux critères absents ne peuvent apparaître", async () => {
  const { rationaleFromModel, assembleExplanation, rationaleCheck } = await import("../lib/qcm-rationale");
  // Le modèle rend aussi deux raisons sur des options qui n'existent pas (indices 4 et 5).
  const r = rationaleFromModel({
    key: "Le cours exige un protocole simple, fiable et digne de confiance pour un usage large.",
    distractors: [
      { option_index: 0, why_wrong: "Les axiomes de Vandrel décrivent des limites, pas des conditions d'adoption." },
      { option_index: 1, why_wrong: "C'est une règle de base évoquée ailleurs, pas une condition d'adoption." },
      { option_index: 2, why_wrong: "Le sceau relève de la provenance, pas du tri." },
      { option_index: 4, why_wrong: "La vitesse de tri et son prix ne sont pas cités." },
      { option_index: 5, why_wrong: "L'ouverture du registre n'est pas avancée." },
    ],
  }, Q10.options.length, Q10.correct, "fr")!;
  assert.deepEqual(rationaleCheck(r, 4, Q10.correct), { ok: true, key: true, missing: [], orphan: [] });
  const text = assembleExplanation(r, Q10.options, Q10.correct);
  assert.doesNotMatch(text, /vitesse de tri|ouverture du registre/);
  const lines = text.split("\n");
  assert.equal(lines.length, 4, text);
  assert.match(lines[0], /^D \(juste\) — « Être simple à appliquer/);
  assert.match(lines[1], /^A \(faux\) — « Respecter les trois axiomes de Vandrel/);
  assert.match(lines[3], /^C \(faux\) — « Marquer chaque glorbe/);
});

test("Q13 : quatre réfutations pour trois distracteurs → trois lignes, une par distracteur ; la « prohibition stricte » absente ne passe pas", async () => {
  const { rationaleFromModel, assembleExplanation } = await import("../lib/qcm-rationale");
  const options = [
    "Un signal discret qui oriente le pilote zarvin sans restreindre ses choix.",
    "Le retrait du réglage d'usine, qui force un choix actif.",
    "Une consigne affichée, qui supprime la liberté du pilote.",
    "Un réglage automatique, appliqué sans action du pilote.",
  ];
  const r = rationaleFromModel({
    key: "Le dispositif oriente sans contraindre.",
    distractors: [
      { option_index: 1, why_wrong: "Mécanisme différent : on force un choix." },
      { option_index: 2, why_wrong: "Une consigne affichée contraint directement." },
      { option_index: 3, why_wrong: "Confond avec un réglage automatique." },
      { option_index: 2, why_wrong: "Une prohibition stricte empêcherait tout autre usage." }, // doublon d'indice
      { option_index: 0, why_wrong: "Sur la clé : ignorée." },
    ],
  }, 4, [0], "fr")!;
  const text = assembleExplanation(r, options, [0]);
  assert.equal(text.split("\n").filter((l) => /\(faux\)/.test(l)).length, 3, text);
  assert.doesNotMatch(text, /prohibition stricte|Sur la clé/);
});

test("Q8 : un distracteur remplacé perd sa raison (la variante absente) ; le mélange réindexe sans rien perdre", async () => {
  const { rationaleFromModel, invalidateRationale, assembleExplanation, rationaleCheck, permuteRationale } = await import("../lib/qcm-rationale");
  const { shuffleQcmOptions } = await import("../lib/qcm");
  const options = [
    "Évaluer l'effet de l'incident sur l'image de la station.",
    "Évaluer les risques des échanges de quimbes entre stations, y compris ceux restés dans une seule station.",
    "Analyser l'effet du choix des relais sur les coûts.",
    "Évaluer les risques des échanges de quimbes entre stations, règles des autres stations comprises.",
  ];
  const r = rationaleFromModel({ key: "Le cours vise les échanges entre stations et les règles des autres stations.", distractors: [
    { option_index: 0, why_wrong: "L'image de la station n'est pas l'objectif visé." },
    { option_index: 1, why_wrong: "Les échanges restés dans une seule station dépassent ce que vise le cours." },
    { option_index: 2, why_wrong: "C'est un autre objectif de l'exercice." },
  ] }, 4, [3], "fr")!;
  // L'option 1 est remplacée (distracteur éliminable) : sa raison part avec elle.
  const replaced = options.slice();
  replaced[1] = "Évaluer les risques des échanges de quimbes entre stations, à l'identique sous un cadre équivalent.";
  const after = invalidateRationale(r, [1]);
  assert.deepEqual(rationaleCheck(after, 4, [3]).missing, [1]);
  assert.doesNotMatch(assembleExplanation(after, replaced, [3]), /restés dans une seule station/);
  // Le mélange (même graine que le moteur) réindexe : chaque raison reste sur SON option.
  const item = { stem: "s", options, correct: [3], misconceptions: ["", "", "", ""], rationale: r, explanation: "" };
  for (let seed = 1; seed < 40; seed++) {
    const sh = shuffleQcmOptions(item, seed);
    for (let k = 0; k < 4; k++) {
      const from = options.indexOf(sh.options[k]);
      assert.equal(sh.rationale!.wrong[k], r.wrong[from], `graine ${seed}, option ${k}`);
    }
    assert.equal(sh.explanation, assembleExplanation(sh.rationale!, sh.options, sh.correct));
  }
  assert.deepEqual(permuteRationale(r, [3, 2, 1, 0]).wrong, [...r.wrong].reverse());
});

test("mélange + remplacements répétés : chaque ligne de l'explication cite l'option qui porte sa lettre", async () => {
  const { rationaleFromModel, invalidateRationale, assembleExplanation } = await import("../lib/qcm-rationale");
  const { shuffleQcmOptions, syncExplanation } = await import("../lib/qcm");
  let it = {
    stem: "s", options: ["Clé [o0]", "Faux [o1]", "Faux [o2]", "Faux [o3]"], correct: [0], misconceptions: ["", "", "", ""], explanation: "",
    rationale: rationaleFromModel({ key: "k", distractors: [1, 2, 3].map((k) => ({ option_index: k, why_wrong: `contredit [o${k}]` })) }, 4, [0], "fr"),
  };
  let next = 4;
  for (let round = 0; round < 30; round++) {
    it = shuffleQcmOptions(it, round * 7 + 3);
    // Remplacement d'un distracteur : nouvelle option, nouvelle raison (le même appel l'écrit).
    const j = [0, 1, 2, 3].find((k) => !it.correct.includes(k) && (round + k) % 2 === 0) ?? it.options.findIndex((_, k) => !it.correct.includes(k));
    const tok = `[o${next++}]`;
    it.options = it.options.map((o, k) => (k === j ? `Remplaçant ${tok}` : o));
    it.rationale = invalidateRationale(it.rationale!, [j]);
    it.rationale.wrong[j] = `contredit ${tok}`;
    syncExplanation(it);
    for (const line of it.explanation.split("\n")) {
      const m = /^([A-D]) \((?:juste|faux)\) — « (.+?) » : (.*)$/.exec(line);
      assert.ok(m, line);
      const k = "ABCD".indexOf(m[1]);
      assert.equal(it.options[k], m[2], `la lettre ${m[1]} cite son option : ${it.explanation}`);
      const cited = /\[o\d+\]/.exec(m[3])?.[0];
      if (cited) assert.ok(it.options[k].includes(cited), `la raison porte sur l'option de sa ligne : ${line}`);
    }
    assert.equal(it.explanation, assembleExplanation(it.rationale, it.options, it.correct));
  }
});

test("filet : une raison qui cite une option par son rang est réécrite sur son contenu ; la clé qui réfute d'autres options est réduite à la clé", async () => {
  const { cleanRationale } = await import("../lib/qcm");
  const options = ["L'effet Morvane", "L'effet Talquin", "L'effet Brisel", "L'effet Dovran"];
  const r = cleanRationale({ key: "Le cours définit ainsi l'effet Brisel.", wrong: ["Contrairement à la deuxième option, il porte sur la mémoire.", "", "", "x"], lang: "fr" }, options, [2, 1]);
  assert.doesNotMatch(r.wrong[0], /deuxième option/);
  assert.match(r.wrong[0], /« L'effet Talquin »/);
  assert.equal(r.wrong[1], "", "aucune raison sur une bonne réponse");
});

test("lecture : un QCM enregistré avec sa justification se réassemble sur ses options ; un examen d'avant garde son texte", async () => {
  const { storedExplanation, toStoredRationale, rationaleFromModel } = await import("../lib/qcm-rationale");
  const options = ["Une", "Deux", "Trois", "Quatre"];
  const r = rationaleFromModel({ key: "Parce que.", distractors: [0, 1, 3].map((k) => ({ option_index: k, why_wrong: `non ${k}` })) }, 4, [2], "en")!;
  const row = { rationale_json: JSON.stringify(toStoredRationale(r, 4, [2])), options_json: JSON.stringify(options), correct_json: "[2]" };
  assert.equal(storedExplanation(row, "ancien"), "C (correct) — “Trois”: Parce que.\nA (wrong) — “Une”: non 0\nB (wrong) — “Deux”: non 1\nD (wrong) — “Quatre”: non 3");
  assert.equal(storedExplanation({ ...row, rationale_json: null }, "ancien texte"), "ancien texte");
  assert.equal(storedExplanation({ ...row, rationale_json: "{pas du json" }, "ancien texte"), "ancien texte");
});

// ───────────────────────────── rejeu simulé ─────────────────────────────

const KEY = "Il est exact que";
const C = "bcdfghjklmnpqrstvwxz";
const V = "aeiou";
const word = (i: number, j: number, k: number) => `${C[i]}${V[j]}${C[k + 5]}${V[(i + k) % 5]}rinde`;
const NOTIONS = 15;
const label = (i: number) => `Notion ${C[i].toUpperCase()}a${C[(i + 1) % C.length]}ide`;
const statement = (i: number, j: number) => `le ${word(i, j, 0)} suit le ${word(i, j, 1)} si le ${word(i, j, 2)} reste ${word(i, j, 3)}.`;
const where = new Map<string, number>();
for (let i = 0; i < NOTIONS; i++) for (let j = 0; j < 4; j++) where.set(statement(i, j), i);

/** Jeton unique de chaque option jamais écrite : une explication qui en cite un absent est incohérente. */
let oid = 0;
const tok = () => `[o${++oid}]`;
let designed = 0;
const calls = { facts: 0, design: 0, verify: 0, repair: 0, audit: 0, dedup: 0, rewrite: 0, justify: 0, other: 0 };
const total = () => Object.values(calls).reduce((a, b) => a + b, 0);

function extract(prompt: string): string {
  const k = Number(/Au plus (\d+) faits par notion/.exec(prompt)?.[1] ?? 4);
  const notions = [...prompt.matchAll(/^N(\d+)\. (.+)$/gm)].map((m) => ({ n: Number(m[1]), i: Array.from({ length: NOTIONS }, (_, i) => i).find((i) => label(i) === m[2].trim()) ?? -1 }));
  return JSON.stringify({ facts: notions.filter((x) => x.i >= 0).flatMap(({ n, i }) => Array.from({ length: Math.min(k, 4) }, (_, j) => ({ notion: n, statement: statement(i, j), passage: `${label(i)} : ${statement(i, j)}` }))) });
}

const opts = (body: string) => [...body.matchAll(/^\s+\((\d+)\) (.*?)(?:\s{2}(?:\(bonne réponse|←|\[).*)?$/gm)].map((m) => ({ k: Number(m[1]), text: m[2] }));
function blocks(prompt: string): { index: number; body: string }[] {
  return [...prompt.matchAll(/^Q(\d+)\.([\s\S]*?)(?=^Q\d+\.|$(?![\s\S]))/gm)].map((m) => ({ index: Number(m[1]), body: m[0] }));
}

/**
 * Concepteur simulé. Paragraphe libre : il réfute chaque distracteur par son jeton, et dérive comme
 * l'examen #15 — une question sur cinq réfute deux options inventées (Q10), une sur sept une
 * quatrième (Q13), sous une tournure que les contrôles lexicaux ne lisent pas toujours.
 * Justification : les mêmes dérives deviennent des entrées hors des options, en double, ou une
 * raison qui cite l'option par son rang ; une question sur onze oublie une raison.
 * Une question sur six recopie le sujet d'une AUTRE notion (Q1).
 */
function design(prompt: string): string {
  const structured = /"justification"/.test(prompt);
  const lines = [...prompt.matchAll(/^ {2}(\d+)\) (.+)$/gm)].map((m) => m[2]);
  const n = Number(/\((\d+) QCM\)/.exec(prompt)?.[1] ?? 1);
  return JSON.stringify({ items: Array.from({ length: n }, (_, k) => {
    const g = ++designed;
    const m = /^(.+?) — FAIT À TESTER \[(f-[0-9a-f]+)\] : (.+?)$/.exec(lines[k] ?? "");
    const notion = m ? where.get(m[3].trim()) ?? 0 : 0;
    const topic = g % 6 === 0 ? label((notion + 5) % NOTIONS) : (m?.[1] ?? lines[k] ?? "").trim();
    const options = [
      `${KEY} ${m?.[3].trim() ?? topic} ${tok()}`,
      `Une affirmation inversée ${tok()}.`,
      g % 3 === 0 ? `Une option absurde réparable ${tok()}.` : `Une condition changée ${tok()}.`,
      `Une étude mal attribuée ${tok()}.`,
    ];
    const t = options.map((o) => /\[o\d+\]/.exec(o)![0]);
    const base = { topic, type: "scq", stem: `Question ${g} : que dit le cours sur ${topic} (cas ${g}) ?`, options, correct: [0], misconceptions: options.map((_, x) => (x ? "[inversion] x" : "")), source_fact: m ? `${label(notion)} : ${m[3].trim()}` : "", ...(m ? { fact_id: m[2] } : {}) };
    if (!structured) {
      const extra = g % 5 === 0 ? ` Le critère ${tok()} et le critère ${tok()} ne sont pas retenus.` : g % 7 === 0 ? ` Le cas ${tok()} relève d'une autre condition.` : "";
      return { ...base, explanation: `La bonne réponse ${t[0]} reprend le fait. Le cas ${t[1]} inverse le cours ; le cas ${t[2]} change une condition ; le cas ${t[3]} se trompe d'étude.${extra}` };
    }
    const distractors = [1, 2, 3].filter((x) => !(g % 11 === 0 && x === 3)).map((x) => ({ option_index: x, why_wrong: g % 5 === 0 && x === 1 ? `Contrairement à la première option, le cas ${t[x]} inverse le cours.` : `Le cas ${t[x]} contredit le fait.` }));
    if (g % 5 === 0) distractors.push({ option_index: 4, why_wrong: `Le critère ${tok()} n'est pas retenu.` });
    if (g % 7 === 0) distractors.push({ option_index: 2, why_wrong: `Le cas ${tok()} relève d'une autre condition.` });
    return { ...base, justification: { key: `Le fait du cours l'établit ${t[0]}.`, distractors } };
  }) });
}

function verify(prompt: string): string {
  return JSON.stringify({ results: blocks(prompt).map(({ index, body }) => {
    const o = opts(body);
    const key = o.find((x) => x.text.startsWith(KEY))?.k ?? 0;
    const g = Number(/cas (\d+)/.exec(body)?.[1] ?? 1);
    const reject = g % 9 === 0;
    return {
      index, correct: reject ? [(key + 1) % 4] : [key], ok: !reject, discrimination: 4, name_only: false, issue: reject ? "clé contestée" : "",
      course_terms: [], off_course: "", off_course_terms: [], off_course_options: [], off_course_key: false, off_matter: "",
      trivial_distractors: o.filter((x) => x.text.startsWith("Une option absurde")).map((x) => x.k), definition_mismatch: "",
    };
  }) });
}

/**
 * Remplacement simulé. Paragraphe libre : une fois sur deux, l'explication rendue désigne les
 * options par leur rang (refusée) et l'ancienne, qui réfute l'option partie, reste. Justification :
 * sans schéma strict, une fois sur deux, la raison du remplaçant manque ; avec le schéma (qui
 * l'exige, comme le font les fournisseurs à sortie structurée), elle est toujours là.
 */
let repairs = 0;
function repair(prompt: string, strict: boolean): string {
  const structured = /"why_wrong"/.test(prompt);
  return JSON.stringify({ replacements: blocks(prompt).map(({ index, body }) => {
    const o = opts(body);
    const fresh = [...body.matchAll(/^\s+\((\d+)\) .*?← À REMPLACER/gm)].map((x) => ({ option: Number(x[1]), text: `Une affirmation voisine réparée ${tok()}.`, misconception: "[mauvaise condition] x" }));
    const r = ++repairs;
    if (structured) return { index, distractors: fresh.map((d) => ({ ...d, ...(strict || r % 2 ? { why_wrong: `Le remplaçant ${/\[o\d+\]/.exec(d.text)![0]} change une condition.` } : {}) })) };
    const final = o.map((x) => fresh.find((d) => d.option === x.k)?.text ?? x.text);
    const t = final.map((x) => /\[o\d+\]/.exec(x)?.[0] ?? "");
    return { index, distractors: fresh, explanation: r % 2 ? `La deuxième option est fausse, la première est juste.` : `La bonne réponse ${t[0]} reprend le fait. Le cas ${t[1]} inverse ; le cas ${t[2]} change ; le cas ${t[3]} se trompe.` };
  }) });
}

/** Réécriture d'explication libre (porte de sortie) : sur les options réelles. */
function rewrite(prompt: string): string {
  return JSON.stringify({ explanations: blocks(prompt).map(({ index, body }) => {
    const t = opts(body).map((x) => /\[o\d+\]/.exec(x.text)?.[0] ?? "");
    return { index, explanation: `La bonne réponse ${t[0]} reprend le fait ; le cas ${t[1]} inverse, le cas ${t[2]} change, le cas ${t[3]} se trompe.` };
  }) });
}

/** Cases de justification écrites seules : seulement celles marquées. */
function justify(prompt: string): string {
  return JSON.stringify({ justifications: blocks(prompt).map(({ index, body }) => ({
    index,
    key: /← À JUSTIFIER \(key\)/.test(body) ? "Le fait du cours l'établit." : "",
    distractors: [...body.matchAll(/^\s+\((\d+)\) (.*?)\s+← À JUSTIFIER \(pourquoi/gm)].map((x) => ({ option_index: Number(x[1]), why_wrong: `Le cas ${/\[o\d+\]/.exec(x[2])?.[0] ?? ""} contredit le fait.` })),
  })) });
}

/** Audit final simulé : verdicts, et les cases « À JUSTIFIER » quand il y en a (même appel). */
function audit(prompt: string): string {
  const qs = blocks(prompt);
  return JSON.stringify({
    verdicts: qs.map(({ index, body }) => ({ index, key: true, offCourse: false, trivial: opts(body).filter((x) => x.text.startsWith("Une option absurde")).map((x) => x.k) })),
    ...(/"justifications"/.test(prompt) ? { justifications: JSON.parse(justify(prompt)).justifications.filter((j: { key: string; distractors: unknown[] }) => j.key || j.distractors.length) } : {}),
  });
}

let llm: http.Server;
before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: { content: unknown }[]; response_format?: unknown };
      const content = parsed.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      let text = "{}";
      if (/\{"facts":/.test(content)) { calls.facts++; text = extract(content); }
      else if (/"offCourse"/.test(content)) { calls.audit++; text = audit(content); }
      else if (/"justifications"/.test(content)) { calls.justify++; text = justify(content); }
      else if (/"replacements"/.test(content)) { calls.repair++; text = repair(content, /why_wrong/.test(JSON.stringify(parsed.response_format ?? ""))); }
      else if (/"duplicates"/.test(content)) { calls.dedup++; text = JSON.stringify({ notions: [], duplicates: [], repeats: [] }); }
      else if (/"results"/.test(content)) { calls.verify++; text = verify(content); }
      else if (/"explanations"/.test(content)) { calls.rewrite++; text = rewrite(content); }
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
  designed = 0;
  repairs = 0;
  delete process.env.QCM_STRUCTURED_EXPLANATIONS;
});

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL", "MAX_COURSES_CREATED_PER_HOUR", "MAX_COURSES_PER_USER", "QCM_FACTS", "QCM_STRUCTURED_EXPLANATIONS"]) delete process.env[k];
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
  const row = buildCourseRow({ name: `Cours fictif explications ${++courseN}`, code: "FIC-115", language: "fr", examFormat: { kind: "qcm" } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics", "exams", "qcm_items"]) await q.ensureTable(t);
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", "Séances", "course_pdf/s1", null, 1);
    for (let i = 0; i < NOTIONS; i++) {
      const text = `${label(i)} : ${Array.from({ length: 4 }, (_, j) => statement(i, j)).join(" ")}`;
      const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", `Séance ${i + 1}`, text);
      await indexItemForSearch(iid, sid, `Séance ${i + 1}`, text);
      await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label(i), null, 30 - i, 1);
    }
  });
  return row.id;
}

type Row = { topic: string; options_json: string; correct_json: string; explanation: string; fact_id: string | null; rationale_json: string | null };

/**
 * Incohérente : l'explication cite le jeton d'une option qui n'est pas dans la question, ou réfute
 * plus d'options fausses que la question n'en a. Lue comme l'étudiant la lit (getQcmExam).
 */
function incoherent(explanation: string, options: string[], correct: number[]): string | null {
  const present = new Set(options.flatMap((o) => o.match(/\[o\d+\]/g) ?? []));
  const cited = [...new Set(explanation.match(/\[o\d+\]/g) ?? [])];
  const absent = cited.filter((t) => !present.has(t));
  const wrongTokens = options.filter((_, k) => !correct.includes(k)).flatMap((o) => o.match(/\[o\d+\]/g) ?? []);
  const refuted = cited.filter((t) => !wrongTokens.includes(t) ? absent.includes(t) : true).length;
  if (absent.length) return `réfute ${absent.join(", ")}, absent(s)`;
  if (refuted > options.length - correct.length) return `${refuted} réfutations pour ${options.length - correct.length} distracteurs`;
  return null;
}

async function generate(id: string) {
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  const { q } = await import("../db/q");
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k] = 0;
  const steps: string[] = [];
  const t0 = Date.now();
  const r = await runWithCourse(id, () => generateQcmExam({ count: 20, openCount: 0, onStep: (s) => steps.push(s) }));
  const ms = Date.now() - t0;
  const view = (await runWithCourse(id, () => getQcmExam(r.id, true)))!.items as unknown as { topic: string; options: string[]; correct: number[]; explanation: string; verified: number | null }[];
  const rows = await runWithCourse(id, () => q.all<Row>(`SELECT topic, options_json, correct_json, explanation, fact_id, rationale_json FROM qcm_items WHERE exam_id = ? ORDER BY idx`, r.id));
  const facts = await runWithCourse(id, () => q.all<{ id: string; notion: string }>(`SELECT id, notion FROM course_facts`));
  const bad = view.map((it, i) => ({ i, why: incoherent(it.explanation, it.options, it.correct) })).filter((x) => !!x.why);
  const detail = `${r.count}/20 · ${total()} appels ${JSON.stringify(calls)} · ${bad.length} explication(s) incohérente(s) ${JSON.stringify(bad)} · ${ms} ms\n${steps.filter((s) => /Contrôle final|Explications assemblées|justification/.test(s)).join("\n")}`;
  return { r, view, rows, facts, bad, steps, calls: { ...calls, total: total() }, detail };
}

test("examen #15 rejoué : avant, des explications réfutent des options absentes ; après, aucune, sans plus d'appels", async (t) => {
  process.env.QCM_STRUCTURED_EXPLANATIONS = "0";
  const before = await generate(await course());
  t.diagnostic(`AVANT (paragraphe libre) : ${before.detail}`);
  assert.equal(before.r.count, 20, before.detail);
  assert.ok(before.rows.every((r) => !r.rationale_json), "interrupteur coupé : aucune justification structurée");

  delete process.env.QCM_STRUCTURED_EXPLANATIONS;
  designed = 0;
  repairs = 0;
  const after = await generate(await course());
  t.diagnostic(`APRÈS (justification structurée) : ${after.detail}`);
  assert.equal(after.r.count, 20, after.detail);
  assert.ok(after.view.every((it) => it.verified === 1), after.detail);
  assert.equal(after.bad.length, 0, `aucune explication incohérente : ${after.detail}`);
  // Contrôle déterministe final : une raison par distracteur réel, chaque raison sur une option qui existe.
  const { fromStoredRationale, rationaleCheck } = await import("../lib/qcm-rationale");
  for (const row of after.rows) {
    const options = JSON.parse(row.options_json) as string[];
    const correct = JSON.parse(row.correct_json) as number[];
    const r = fromStoredRationale(row.rationale_json, options.length, correct);
    assert.ok(r, `justification enregistrée : ${row.explanation}`);
    assert.deepEqual(rationaleCheck(r, options.length, correct), { ok: true, key: true, missing: [], orphan: [] }, row.explanation);
    assert.equal(row.explanation.split("\n").filter((l) => /\(faux\)/.test(l)).length, options.length - correct.length, row.explanation);
  }
  // Les dérives du concepteur simulé ont bien eu lieu (raisons oubliées), complétées dans l'audit.
  assert.ok(after.steps.some((s) => /justification\(s\) complétée\(s\) au passage/.test(s)), `cases manquantes écrites dans l'audit : ${after.detail}`);
  // Coût : la justification remplace le paragraphe dans le même appel, les cases manquantes sont
  // écrites dans l'audit qui passe déjà, la réécriture libre de la porte de sortie disparaît.
  assert.equal(after.calls.design, before.calls.design, `même nombre de conceptions : ${after.detail}`);
  assert.ok(after.calls.total <= before.calls.total, `pas plus d'appels : ${after.calls.total} contre ${before.calls.total}`);
  assert.equal(after.calls.rewrite, 0, "plus de réécriture d'explication libre");
});

test("étiquette : la notion affichée est celle du fait testé, même quand le concepteur recopie un autre sujet (Q1)", async (t) => {
  const run = await generate(await course());
  t.diagnostic(run.detail);
  assert.equal(run.r.count, 20, run.detail);
  const notionOf = new Map(run.facts.map((f) => [f.id, f.notion]));
  for (const [i, row] of run.rows.entries()) {
    assert.ok(row.fact_id, `question ${i + 1} rattachée à un fait`);
    assert.equal(row.topic, notionOf.get(row.fact_id!), `question ${i + 1} : « ${row.topic} » au lieu de la notion du fait`);
    assert.equal(run.view[i].topic, row.topic);
  }
});

test("interrupteur QCM_STRUCTURED_EXPLANATIONS=0 : schéma et explications d'avant, aucune colonne remplie", async (t) => {
  process.env.QCM_STRUCTURED_EXPLANATIONS = "0";
  const run = await generate(await course());
  t.diagnostic(run.detail);
  assert.equal(run.r.count, 20, run.detail);
  assert.ok(run.rows.every((r) => r.rationale_json === null));
  assert.ok(run.rows.every((r) => !/\((?:juste|faux)\) — /.test(r.explanation)), "paragraphe libre, pas d'assemblage");
  assert.equal(run.calls.justify, 0);
});

test("options au même début : chacune est citée à partir de ce qui la distingue", async () => {
  const { rationaleFromModel, assembleExplanation } = await import("../lib/qcm-rationale");
  const options = [
    "L'équipe doit évaluer la conception du module dans son contexte réel et ses effets d'ensemble.",
    "L'équipe doit évaluer la conception du module selon ses seuls risques commerciaux.",
    "L'équipe doit évaluer la conception du module hors de tout contexte d'usage.",
  ];
  const r = rationaleFromModel({ key: "k", distractors: [{ option_index: 1, why_wrong: "a" }, { option_index: 2, why_wrong: "b" }] }, 3, [0], "fr")!;
  const lines = assembleExplanation(r, options, [0]).split("\n");
  assert.match(lines[0], /^A \(juste\) — « …dans son contexte réel/);
  assert.match(lines[1], /^B \(faux\) — « …selon ses seuls risques commerciaux » : a$/);
  assert.match(lines[2], /^C \(faux\) — « …hors de tout contexte d'usage » : b$/);
});
