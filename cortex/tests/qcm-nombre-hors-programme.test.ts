/**
 * NOMBRE TENU ET MATIÈRE SEULEMENT — test réel par le MCP du 13/11 (HUM-285, job 12) :
 * 10 QCM sur 20, et 3 des 10 tirés de notes d'archive « hors programme 2026 » (RGPD/LPD,
 * rapports CNUCED) ou de l'archive des posters 2024. Verrouillé, sur Postgres (PGlite) :
 *  - un sujet dont la question est écartée à chaque fois cède sa place à une notion de réserve ;
 *  - réserve épuisée par les doublons : complément final sous un autre angle, nombre tenu ;
 *  - les titres des supports servent de réserve en Postgres (DISTINCT + ORDER BY y échouait) ;
 *  - une source hors programme ou une archive d'organisation ne donne ni passage, ni sujet,
 *    ni notion, ni question.
 * Fournisseur LLM simulé (openai-compatible) : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-nombre-"));
const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: tmp, DB_DRIVER: "postgres", DATABASE_URL: "pglite://memory",
  LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "test", LLM_MODEL_OPUS: "claude-sonnet-5", LLM_MAX_RETRIES: "0",
  MAX_COURSES_CREATED_PER_HOUR: "unlimited", MAX_COURSES_PER_USER: "unlimited",
};
Object.assign(process.env, ENV);

const COURSE_TEXT = "Cours 4 : la souveraineté numérique désigne la capacité d'un État à maîtriser ses données ; df.groupby calcule une moyenne par groupe. Le nudge modifie l'architecture du choix sans interdire d'option. Le biais de statu quo pousse à garder l'option par défaut.";
const ARCHIVE_TEXT = "Hors programme 2026 (Gillet 2025) : le RGPD et la LPD encadrent le traitement des données personnelles ; rapports CNUCED sur l'économie numérique.";
const POSTERS_TEXT = "Thèmes des posters 2024 : 1. surveillance algorithmique ; 2. économie de l'attention ; 3. cybersécurité des hôpitaux.";

/** Sujets d'un prompt de conception : lignes « 1) sujet [méthode] ». */
const subjects = (p: string) => [...p.matchAll(/^ {2}(\d+)\) (.+?)(?: \[|$)/gm)].map((m) => m[2].trim());

function item(topic: string, k: string) {
  return {
    topic,
    type: "scq",
    stem: `Que dit le cours sur ${topic} ? (${k})`,
    options: [
      "La moyenne des revenus calculée séparément pour chaque modalité de sex.",
      "La moyenne des revenus calculée sur toutes les lignes, sans regroupement.",
      "Le nombre de lignes de chaque modalité de sex, sans calcul de moyenne.",
      "La somme des revenus calculée séparément pour chaque modalité de sex.",
    ],
    correct: [0],
    misconceptions: ["", "[sur-généralisation] ignore le regroupement", "[notion voisine] confond mean et count", "[notion voisine] confond mean et sum"],
    explanation: "groupby regroupe par modalité, puis mean calcule la moyenne de chaque groupe.",
  };
}

const allPrompts: string[] = [];
const designPrompts: string[] = [];
let designCalls = 0;
/** Sujet dont le juge déclare chaque question hors matière (vide : aucun). */
let cursed = "";
/** Termes du cours que le juge dit employés (vérifiés dans le corpus, lib/course-grounding). */
let courseTerms = ["groupby"];
let dedupeCalls = 0;
let dedupe: (n: number) => { first: number; second: number; reason: string }[] = () => [];

function verifyReply(prompt: string): string {
  const blocks = prompt.split(/^(?=Q\d+\.)/m).filter((b) => /^Q\d+\./.test(b));
  const results = blocks.map((b) => {
    const i = Number(/^Q(\d+)\./.exec(b)![1]);
    const opt = [...b.matchAll(/^\s+\((\d+)\) (.*)$/gm)].find((m) => /moyenne des revenus calculée séparément/.test(m[2]));
    const offMatter = cursed && b.includes(cursed) ? "porte sur l'organisation du cours" : "";
    return { index: i, correct: [opt ? Number(opt[1]) : 0], ok: true, discrimination: 4, name_only: false, issue: "", course_terms: courseTerms, off_course: "", off_matter: offMatter, trivial_distractors: [], definition_mismatch: "" };
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
      const content = parsed.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      allPrompts.push(content);
      let text = "{}";
      if (/"replacements"/.test(content)) text = JSON.stringify({ replacements: [] });
      else if (/"duplicates"/.test(content)) text = JSON.stringify({ duplicates: dedupe(++dedupeCalls) });
      else if (/"results"/.test(content)) text = verifyReply(content);
      else if (/"items"/.test(content) && /\(\d+ QCM\)/.test(content)) {
        designCalls++;
        designPrompts.push(content);
        const subs = subjects(content);
        text = JSON.stringify({ items: subs.map((s, i) => item(s, `${designCalls}-${i}`)) });
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

beforeEach(() => { courseTerms = ["groupby"]; allPrompts.length = 0; designPrompts.length = 0; designCalls = 0; cursed = ""; dedupeCalls = 0; dedupe = () => []; });

after(async () => {
  await new Promise((r) => llm.close(r));
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of [...Object.keys(ENV), "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

let courseN = 0;
/** Un cours HUM : un support, une note d'archive hors programme, l'archive des posters, des notions. */
async function humCourse(topics: string[]): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const row = buildCourseRow({ name: `Société numérique ${++courseN}`, code: "HUM-285", language: "fr", examFormat: { kind: "qcm", questionCount: 20 } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
    const add = async (type: string, title: string, text: string) => {
      const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, type, title, `${type}/${courseN}/${title}`, null, 1);
      const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, type, title, text);
      await indexItemForSearch(iid, sid, title, text);
    };
    await add("course_pdf", "Cours 4 — souveraineté numérique", COURSE_TEXT);
    await add("note", "Archive Gillet 2025", ARCHIVE_TEXT);
    await add("note", "Thèmes des posters 2024", POSTERS_TEXT);
    for (const label of topics) await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, null, 3, 1);
  });
  return row.id;
}

const NOTIONS = ["Souveraineté numérique", "Nudge", "Biais de statu quo", "Architecture du choix", "Option par défaut", "Données et État", "Moyenne par groupe", "Maîtrise des données", "Capacité d'un État", "Interdiction d'option"];

test("règle : hors programme (titre ou début du texte) et archives d'organisation", async () => {
  const { isExcludedMaterial } = await import("../lib/source-scope");
  for (const [title, head] of [
    ["Archive Gillet 2025 — RGPD et LPD (hors programme 2026)", ""],
    ["Archive Gillet 2025", ARCHIVE_TEXT],
    ["Thèmes des posters 2024", ""],
    ["Notes", POSTERS_TEXT],
    ["Exemple de rendu — essai noté 5,5", ""],
    ["Poster themes 2023", ""],
  ]) assert.equal(isExcludedMaterial(title, head), true, `${title} | ${head.slice(0, 40)}`);
  for (const [title, head] of [
    ["Cours 4 — souveraineté numérique", COURSE_TEXT],
    ["Programme du cours", "Les notions au programme de l'examen."],
    ["Biais de confirmation", ""],
  ]) assert.equal(isExcludedMaterial(title, head), false, title);
});

test("une source hors programme ou une archive ne donne ni passage, ni sujet, ni notion", async () => {
  const id = await humCourse(["Souveraineté numérique", "RGPD et LPD", "Thèmes des posters 2024", "Rapports CNUCED"]);
  const { runWithCourse } = await import("../db/client");
  const { coursePassages, evidencePassages } = await import("../lib/course-grounding");
  const { courseMaterialTitles } = await import("../lib/exam-format");
  const { coverageTopics } = await import("../lib/qcm");
  await runWithCourse(id, async () => {
    const passages = await coursePassages(["RGPD LPD données personnelles", "surveillance algorithmique posters", "souveraineté numérique"]);
    assert.ok(passages.length > 0, "le support du cours donne un passage");
    assert.ok(passages.every((p) => p.src === "Cours 4 — souveraineté numérique"), JSON.stringify(passages.map((p) => p.src)));
    const evidence = await evidencePassages(["RGPD et LPD", "CNUCED"]);
    assert.ok(evidence.every((p) => !/Gillet|posters/.test(p.src)), JSON.stringify(evidence.map((p) => p.src)));
    // Postgres : la requête d'avant (DISTINCT + ORDER BY) échouait et rendait toujours [].
    assert.deepEqual(await courseMaterialTitles(), ["Cours 4 — souveraineté numérique"]);
    const labels = (await coverageTopics()).map((t) => t.label);
    assert.deepEqual(labels, ["Souveraineté numérique"], `notions d'archive écartées à l'usage : ${labels.join(" | ")}`);
  });
});

test("examen QCM : aucune question ni aucun passage tiré des archives", async () => {
  const id = await humCourse(["RGPD et LPD", "Thèmes des posters 2024", "Rapports CNUCED", ...NOTIONS.slice(0, 5)]);
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam } = await import("../lib/qcm");
  const r = await runWithCourse(id, () => generateQcmExam({ count: 4, openCount: 0 }));
  assert.equal(r.count, 4);
  const asked = designPrompts.flatMap(subjects);
  assert.ok(!asked.some((s) => /RGPD|posters|CNUCED|Gillet/i.test(s)), `sujets : ${asked.join(" | ")}`);
  assert.ok(!allPrompts.some((p) => p.includes("Gillet 2025") || p.includes("économie de l'attention")), "le texte des archives n'entre dans aucun prompt");
});

test("notions : l'analyse du programme ne lit pas les archives", async () => {
  const id = await humCourse([]);
  const { runWithCourse } = await import("../db/client");
  const { analyzeBlueprint } = await import("../lib/program");
  await runWithCourse(id, () => analyzeBlueprint().catch(() => null));
  const prompt = allPrompts.find((p) => p.includes(COURSE_TEXT.slice(0, 40)));
  assert.ok(prompt, "l'analyse lit le support du cours");
  assert.ok(!allPrompts.some((p) => p.includes("Gillet 2025") || p.includes("économie de l'attention")), "ni la note hors programme, ni l'archive des posters");
});

test("un sujet écarté à chaque fois cède sa place à une notion de réserve : 8 QCM sur 8", async () => {
  const id = await humCourse(["Notion piège", ...NOTIONS]);
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam } = await import("../lib/qcm");
  cursed = "Notion piège";
  const r = await runWithCourse(id, () => generateQcmExam({ count: 8, openCount: 0 }));
  assert.equal(r.count, 8, `count=${r.count}`);
  assert.equal(r.requested, 8);
  // Conception + régénération ciblée de son lot ; jamais redemandée au comblement.
  const tries = designPrompts.filter((p) => subjects(p).includes("Notion piège")).length;
  assert.ok(tries >= 1 && tries <= 2, `sujet écarté redemandé ${tries} fois`);
  assert.ok(designCalls <= 2 + 2 * 2 + 2, `budget borné (${designCalls} lots pour 2 prévus)`);
});

test("réserve épuisée par les doublons : complément final sous un autre angle, nombre tenu", async () => {
  // 4 notions pour 4 QCM (une notion = une question) ; un seul titre de support en réserve.
  const id = await humCourse(NOTIONS.slice(0, 4));
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam } = await import("../lib/qcm");
  dedupe = (n) => (n <= 2 ? [{ first: 0, second: 1, reason: "même notion" }] : []);
  const r = await runWithCourse(id, () => generateQcmExam({ count: 4, openCount: 0 }));
  assert.equal(r.count, 4, `count=${r.count}`);
  assert.ok(designPrompts.some((p) => /angle VRAIMENT distinct/.test(p) && /NOTIONS DÉJÀ TESTÉES/.test(p)), "le complément reprend une notion sous un autre angle");
  assert.ok(designPrompts.some((p) => subjects(p).includes("Cours 4 — souveraineté numérique")), "le titre du support sert d'abord de réserve");
  assert.equal(dedupeCalls, 3, "le contrôle des doublons repasse sur le complément");
});

// ─── Job 14 de HUM-285 (13/11, après #78) : titres = noms de fichiers ─────────────────────────────
// 14 QCM sur 20, dont des sujets « Archive_2025-26_Thèmes_des_posters_2024.md » ou
// « S_ance_1_…_slides_01.00.md », la diapo des domaines de recherche des enseignants, la grille du
// poster, des notes Gillet hors programme 2026 ; une seule question sur les séances de Cavallaro.

const INTRO_SLIDE = "Présentation des enseignants. Domaines de recherche : Samuel Bendahan, théorie de la décision appliquée ; Denis Gillet, interaction humain-machine et systèmes cyber-physiques.";
const BENDAHAN_TEXT = "Le leadership repose sur la crédibilité ; la science avance par réfutation. Le biais de confirmation pousse à chercher ce qui confirme une croyance. Le double système de pensée oppose un système rapide et intuitif à un système lent et délibératif.";
const CAVALLARO_END = "MARQUEUR-CAVALLARO : la gouvernance de la sécurité de l'IA répartit les responsabilités entre États, laboratoires et organisations internationales.";
const cavallaroText = (n: number) => `${Array.from({ length: 900 }, (_, i) => `séance${n}mot${i}`).join(" ")} ${CAVALLARO_END}`;
const JOB14_ARCHIVES: [string, string][] = [
  ["Archive_2025-26_Thèmes_des_posters_2024.md", POSTERS_TEXT],
  ["Archive_2025-26_Exemple_de_résumé_et_bibliographie_attendu_du_rendu_poster.md", "Résumé : le rewilding par clonage du mammouth dans la toundra ; les températures arctiques augmentent deux fois plus vite."],
  ["Archive_2025-26_Introduction_du_cours_2025_évaluation_enjeu_mondial_critères_du_poster.md", "Un enjeu mondial a une portée transnationale ; critères du poster : clarté, sources."],
  ["Archive_2025-26_Education_numérique_et_entrepreneuriat.md", "Hors programme 2026. Objectifs de développement durable : bâtir une infrastructure résiliente."],
  ["HUM285_grille_eval_quest_essai_2025.md", "Critère D1 : lien conceptuel ; D2 : argumentation ; D3 : bibliographie."],
];
/** Les 11 notions de prod après la re-préparation du job 13. */
const PROD_NOTIONS = ["Biais cognitifs et double système de pensée", "Vérification de l'information et fake news à l'ère de l'IA", "Désinformation générative transnationale", "Souveraineté de l'IA et flux de données", "Lecture critique d'études en économie comportementale", "Modèles économiques du numérique et plateformes", "Sécurité de l'IA, alignement et responsabilités mondiales", "Nudges numériques et architecture du choix", "Processus démocratiques et vote à l'ère numérique", "Inclusion et biais de genre dans les plateformes collaboratives", "Leadership et influence via les réseaux numériques"];
const looksLikeFile = (s: string) => /\.(md|pdf|txt)\b/i.test(s) || /\w_\w/.test(s);

async function job14Course(topics: string[]): Promise<string> {
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
    const add = async (title: string, texts: string[]) => {
      const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "note", title, `note/${courseN}/${title}`, null, 1);
      for (const text of texts) {
        const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "note", title, text);
        await indexItemForSearch(iid, sid, title, text);
      }
    };
    await add("S_ance_1_Bendahan_Leadership_et_science_slides_01.00.md", [INTRO_SLIDE, BENDAHAN_TEXT]);
    for (const n of [5, 6, 7]) await add(`S_ance_${n}_Cavallaro_S_curit_IA_et_responsabilit_s_mondiales.md`, [cavallaroText(n)]);
    for (const [title, text] of JOB14_ARCHIVES) await add(title, [text]);
    for (const label of topics) await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, null, 3, 1);
  });
  return row.id;
}

test("job 14 rejoué : ni archive, ni grille, ni diapo des enseignants exclues à l'œil ; aucun nom de fichier comme notion", async () => {
  const { isExcludedMaterial, isExcludedPassage, materialLabel } = await import("../lib/source-scope");
  for (const [title, text] of JOB14_ARCHIVES) assert.equal(isExcludedMaterial(title, text), true, title);
  assert.equal(isExcludedMaterial("S_ance_1_Bendahan_Leadership_et_science_slides_01.00.md", INTRO_SLIDE), false, "la séance reste au programme");
  assert.equal(isExcludedPassage(INTRO_SLIDE), true, "sa diapo des enseignants, non");
  assert.equal(isExcludedPassage(BENDAHAN_TEXT), false);
  assert.equal(isExcludedPassage("Critères d'évaluation de la fiabilité d'une source : auteur, date, méthode."), false, "un critère de fiabilité est de la matière");
  assert.equal(materialLabel("S_ance_1_Bendahan_Leadership_et_science_slides_01.00.md"), null);
  assert.equal(materialLabel("Souveraineté de l'IA et flux de données"), "Souveraineté de l'IA et flux de données");
});

test("job 14 rejoué : 20 QCM sur 20, sujets = notions du cours, rien des archives ni de la diapo d'introduction", async () => {
  const id = await job14Course(PROD_NOTIONS);
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  // Le juge écarte toute question sur un fichier, un poster ou les enseignants (comme en prod : hors matière).
  cursed = ".md";
  courseTerms = [];
  const r = await runWithCourse(id, () => generateQcmExam({ count: 20, openCount: 0 }));
  assert.equal(r.count, 20, `count=${r.count}`);
  const asked = designPrompts.flatMap(subjects);
  assert.ok(asked.length >= 20);
  assert.ok(!asked.some(looksLikeFile), `aucun nom de fichier comme sujet : ${asked.filter(looksLikeFile).join(" | ")}`);
  assert.ok(!asked.some((s) => /archive|poster|grille/i.test(s)), asked.join(" | "));
  for (const leak of ["Domaines de recherche", "rewilding", "Critère D1", "infrastructure résiliente", "surveillance algorithmique"]) {
    assert.ok(!allPrompts.some((p) => p.includes(leak)), `« ${leak} » n'entre dans aucun prompt`);
  }
  const exam = await runWithCourse(id, () => getQcmExam(r.id));
  assert.ok(exam!.items.every((it) => !looksLikeFile(it.topic)), exam!.items.map((it) => it.topic).join(" | "));
});

test("job 14 rejoué : l'analyse des notions lit chaque séance en entier, aucune archive, et vise une notion par support", async () => {
  const id = await job14Course([]);
  const { runWithCourse } = await import("../db/client");
  const { analyzeBlueprint } = await import("../lib/program");
  await runWithCourse(id, () => analyzeBlueprint().catch(() => null));
  const prompt = allPrompts.find((p) => p.includes("CARTE D'EXAMEN"));
  assert.ok(prompt, "l'analyse a été demandée");
  assert.equal(prompt!.split("MARQUEUR-CAVALLARO").length - 1, 3, "la fin de chacune des 3 séances de Cavallaro est lue");
  assert.ok(prompt!.includes("double système de pensée"), "la séance de Bendahan aussi");
  for (const leak of ["Domaines de recherche", "rewilding", "Critère D1", "infrastructure résiliente", "surveillance algorithmique"]) assert.ok(!prompt!.includes(leak), leak);
  assert.match(prompt!, /CHAQUE support du plan/);
  assert.match(prompt!, /« S ance 5 Cavallaro S curit IA et responsabilit s mondiales »/, "supports nommés sans « _ » ni extension");
  assert.match(prompt!, /Vise \d+ à \d+ notions LARGES/);
  const { notionTarget } = await import("../lib/program");
  assert.equal(notionTarget(11), "11 à 14", "à peu près une notion large par support (banc du 13/11 : 32 notions fines → 9 QCM sur 20)");
  assert.equal(notionTarget(3), "8 à 11");
});
