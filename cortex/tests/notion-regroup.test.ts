/**
 * Regroupement des notions d'un cours déjà indexé (scripts/index-from-bank.ts --regrouper).
 *
 * Cas réel : le Programme ML en production affichait 59 notions pour 130 exos, presque toutes
 * « tombées 1 fois », avec des quasi-doublons (« Overfitting », « Generalization / overfitting »…).
 * Le recalcul avait tourné sans modèle : l'agrégation était retombée sur « un type par libellé
 * brut », et rien ne le signalait. Ces tests tiennent les trois propriétés du correctif :
 *  1. un regroupement donné s'applique SANS appel modèle, sans toucher aux exos ni au plan ;
 *  2. un plan enregistré ne s'applique qu'à l'index sur lequel il a été calculé ;
 *  3. le repli par libellé reste le comportement par défaut, mais il se voit (`clustered: false`).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

(process.env as Record<string, string | undefined>).NODE_ENV = "development";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-regroup-"));
const env = process.env as Record<string, string | undefined>;
env.CORTEX_DATA_DIR = tmp;
delete env.DB_DRIVER;
delete env.DATABASE_URL;
delete env.CORTEX_USER;
// Fournisseur sans endpoint : tout appel modèle lève aussitôt, sans réseau. Un test qui passe
// prouve donc qu'aucun modèle n'a été nécessaire.
env.LLM_PROVIDER = "openai-compatible";
delete env.LLM_BASE_URL;

const COURSE = "apprentissage";
const OWNER = "lea";

/** Index réduit du cas ML : 7 libellés bruts, 12 exos, dont trois écritures de k-NN. */
const INDEX: [string, number][] = [
  ["Overfitting", 2], ["Generalization / overfitting", 1], ["Regularization", 2],
  ["k-NN", 2], ["k-Nearest Neighbors", 3], ["K-Nearest Neighbors", 1], ["PCA", 1],
];
const CLUSTERS = [
  { label: "Generalization & Overfitting", category: "Model assessment", members: ["Overfitting", "Generalization / overfitting", "Regularization"] },
  { label: "k-Nearest Neighbors", members: ["k-NN", "k-Nearest Neighbors", "K-Nearest Neighbors"] },
  { label: "PCA", members: ["PCA"] },
];

async function inCourse<T>(fn: () => Promise<T>): Promise<T> {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  return runWithUser(OWNER, () => runWithCourse(COURSE, fn));
}

/** Remet le cours dans l'état « recalcul sans modèle » : index, plan de 3 chapitres, aucune notion. */
async function seed(): Promise<void> {
  const { q } = await import("../db/q");
  const { ensureIndexSchema } = await import("../lib/exam-index");
  const { ensureProgramSchema } = await import("../lib/program");
  const { ensurePlanSchema } = await import("../lib/course-plan");
  await ensureIndexSchema();
  await ensureProgramSchema();
  await ensurePlanSchema();
  await q.exec(`DELETE FROM mastery`);
  await q.exec(`DELETE FROM topics`);
  await q.exec(`DELETE FROM exam_exercises`);
  await q.exec(`DELETE FROM plan_chapters`);
  let page = 1;
  for (const [topic, n] of INDEX)
    for (let i = 0; i < n; i++)
      await q.run(`INSERT INTO exam_exercises (exam_title, exam_year, exam_page, topic, statement, points) VALUES (?,?,?,?,?,?)`, "Final", 2024, page++, topic, `Énoncé ${topic} ${i}`, 2);
  for (const [seq, no, title] of [[0, 5, "k-Nearest Neighbors"], [1, 6, "Overfitting and Regularization"], [2, 11, "Dimensionality Reduction"]] as const)
    await q.run(`INSERT INTO plan_chapters (seq, lecture_no, title) VALUES (?,?,?)`, seq, no, title);
}

const exosSnapshot = async () => {
  const { q } = await import("../db/q");
  return q.all(`SELECT id, exam_title, exam_year, exam_page, topic, statement, points FROM exam_exercises ORDER BY id`);
};
const chaptersSnapshot = async () => {
  const { q } = await import("../db/q");
  return q.all(`SELECT id, seq, lecture_no, title FROM plan_chapters ORDER BY id`);
};

before(async () => {
  const { insertCourse } = await import("../db/courses-store");
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  await insertCourse({
    id: COURSE, owner_user_id: OWNER, name: COURSE, short: COURSE, code: null, exam_name: COURSE, exam_kind: "Final", university: null,
    university_lines: "[]", faculty: null, teachers: "[]", language: "fr", profile_id: null, duration_min: 120,
    exam_date: null, db_file: null, refs_rel: null, exams_rel: null, uploads_rel: null, content_rel: null,
    created_at: "2026-10-13 00:00:00",
  });
  await reloadCourses();
});
after(() => {
  for (const k of ["CORTEX_DATA_DIR", "NODE_ENV", "LLM_PROVIDER"]) delete env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("partition : comptes réels, libellé oublié gardé tel quel, labels équivalents fusionnés", async () => {
  const { partitionIndex } = await import("../lib/program");
  const exo = (topic: string) => ({ topic, method: null, exo_type: null, trap: null, archetype: null });
  const exos = INDEX.flatMap(([topic, n]) => Array.from({ length: n }, () => exo(topic)));
  const types = partitionIndex(exos, [
    CLUSTERS[0],
    { label: "k-Nearest Neighbors", members: ["k-NN", "k-Nearest Neighbors"] },
    { label: "K-nearest neighbors", members: ["K-Nearest Neighbors"] }, // même type, autre casse
    // « PCA » n'est couvert par aucun type
  ], new Set());
  assert.deepEqual(
    types.map((t) => [t.label, t.count, [...t.rawLabels].sort()]),
    [
      ["Generalization & Overfitting", 5, ["Generalization / overfitting", "Overfitting", "Regularization"]],
      ["k-Nearest Neighbors", 6, ["K-Nearest Neighbors", "k-NN", "k-Nearest Neighbors"]],
      ["PCA", 1, ["PCA"]],
    ],
  );
  assert.equal(types.reduce((s, t) => s + t.count, 0), exos.length, "aucun exo perdu ni compté deux fois");
});

test("plan : seul un plan calculé sur le même index s'applique", async () => {
  const { parsePlan, planMismatches } = await import("../lib/notion-regroup");
  const plan = parsePlan({
    course: COURSE, createdAt: "2026-10-13T00:00:00.000Z", index: Object.fromEntries(INDEX),
    types: CLUSTERS.map((c, i) => ({ ...c, lecture_no: [6, 5, 11][i] })),
  });
  assert.deepEqual(planMismatches(plan, new Map(INDEX)), [], "index identique → aucun écart");

  const drifted = new Map(INDEX);
  drifted.set("PCA", 2); // un exo de plus
  drifted.set("SVM", 3); // un libellé apparu depuis
  drifted.delete("k-NN"); // un libellé disparu
  const gaps = planMismatches(plan, drifted).join("\n");
  assert.match(gaps, /« PCA » : 2 exo\(s\) dans l'index, 1 dans le plan/);
  assert.match(gaps, /« SVM » \(×3\) est dans l'index mais pas dans le plan/);
  assert.match(gaps, /« k-NN » est dans le plan mais plus dans l'index/);

  const twice = { ...plan, types: [...plan.types, { label: "Doublon", members: ["PCA"], lecture_no: null }] };
  assert.match(planMismatches(twice, new Map(INDEX)).join("\n"), /« PCA » appartient à 2 types du plan/);
  const holed = { ...plan, types: plan.types.slice(0, 2) };
  assert.match(planMismatches(holed, new Map(INDEX)).join("\n"), /« PCA » n'appartient à aucun type du plan/);
});

test("plan : un fichier malformé est refusé avec sa raison", async () => {
  const { parsePlan } = await import("../lib/notion-regroup");
  const ok = { course: COURSE, index: { PCA: 1 }, types: [{ label: "PCA", members: ["PCA"], lecture_no: 11 }] };
  assert.equal(parsePlan(ok).types[0].lecture_no, 11);
  assert.throws(() => parsePlan([]), /objet JSON/);
  assert.throws(() => parsePlan({ ...ok, course: "" }), /course/);
  assert.throws(() => parsePlan({ ...ok, index: { PCA: 0 } }), /compte invalide/);
  assert.throws(() => parsePlan({ ...ok, types: [] }), /types/);
  assert.throws(() => parsePlan({ ...ok, types: [{ label: "PCA", members: [] }] }), /membres/);
  assert.throws(() => parsePlan({ ...ok, types: [{ label: "PCA", members: ["PCA"], lecture_no: "11" }] }), /lecture invalide/);
});

test("affichage : notions par chapitre dans l'ordre du plan, sans chapitre à la fin", async () => {
  const { renderPartition, partitionStats } = await import("../lib/notion-regroup");
  const notions = [
    { label: "PCA", count: 1, lectureNo: 11 }, { label: "k-Nearest Neighbors", count: 6, lectureNo: 5 },
    { label: "Generalization & Overfitting", count: 5, lectureNo: 6 }, { label: "Hors plan", count: 2, lectureNo: 99 },
  ];
  const chapters = [{ lecture_no: 5, title: "k-NN" }, { lecture_no: 6, title: "Overfitting" }, { lecture_no: 11, title: "Reduction" }];
  assert.equal(renderPartition(notions, chapters), [
    "1. k-NN : 1 notion(s), 6 occurrence(s)", "     ×6  k-Nearest Neighbors",
    "2. Overfitting : 1 notion(s), 5 occurrence(s)", "     ×5  Generalization & Overfitting",
    "3. Reduction : 1 notion(s), 1 occurrence(s)", "     ×1  PCA",
    "Non rattachées : 1 notion(s), 2 occurrence(s)", "     ×2  Hors plan",
  ].join("\n"));
  assert.deepEqual(partitionStats(notions), { notions: 4, once: 1, max: 6, occurrences: 14, unattached: 0 });
});

test("sans modèle et sans regroupement fourni : repli par libellé, signalé par clustered=false", async () => {
  await inCourse(async () => {
    await seed();
    const { aggregateTopicsFromIndex } = await import("../lib/program");
    const steps: string[] = [];
    const r = await aggregateTopicsFromIndex({ onStep: (m) => steps.push(m) });
    assert.equal(r.clustered, false);
    assert.equal(r.count, 6, "un type par libellé normalisé : les deux casses de k-Nearest Neighbors n'en font qu'un");
    assert.ok(steps.some((m) => m.includes("repli par label")), "le repli est annoncé");
  });
});

test("essai à blanc : la partition est calculée, rien n'est écrit", async () => {
  await inCourse(async () => {
    await seed();
    const { q } = await import("../db/q");
    const { aggregateTopicsFromIndex } = await import("../lib/program");
    const exos = await exosSnapshot();
    const r = await aggregateTopicsFromIndex({ clusters: CLUSTERS, dryRun: true });
    assert.deepEqual(r.types.map((t) => [t.label, t.count]), [["Generalization & Overfitting", 5], ["k-Nearest Neighbors", 6], ["PCA", 1]]);
    assert.equal((await q.all(`SELECT id FROM topics`)).length, 0, "aucune notion écrite");
    assert.equal((await q.all(`SELECT id FROM exam_exercises WHERE topic_id IS NOT NULL`)).length, 0, "aucun exo relié");
    assert.deepEqual(await exosSnapshot(), exos);
  });
});

test("regroupement appliqué sans modèle : notions regroupées, exos et chapitres intacts", async () => {
  await inCourse(async () => {
    await seed();
    const { q } = await import("../db/q");
    const { aggregateTopicsFromIndex } = await import("../lib/program");
    const { mapNotionsToChapters } = await import("../lib/course-plan");

    // État de départ : le repli par libellé, tel qu'en production, plus une notion de série.
    await aggregateTopicsFromIndex();
    await q.run(`INSERT INTO topics (label, exam_weight, exam_count, source, plan_chapter_id) VALUES (?,?,?,?,?)`, "Decision trees", 1, 0, "serie", (await q.get<{ id: number }>(`SELECT id FROM plan_chapters WHERE lecture_no = 5`))!.id);
    const exos = await exosSnapshot();
    const chapters = await chaptersSnapshot();

    const steps: string[] = [];
    const agg = await aggregateTopicsFromIndex({ clusters: CLUSTERS, onStep: (m) => steps.push(m) });
    assert.equal(agg.clustered, true);
    assert.ok(!steps.some((m) => m.includes("repli")), "aucun appel modèle tenté, donc aucun repli");

    const topics = await q.all<{ label: string; exam_count: number; source: string }>(`SELECT label, exam_count, source FROM topics ORDER BY exam_count DESC, label`);
    assert.deepEqual(topics.map((t) => [t.label, t.exam_count, t.source]), [
      ["k-Nearest Neighbors", 6, "final"], ["Generalization & Overfitting", 5, "final"], ["PCA", 1, "final"], ["Decision trees", 0, "serie"],
    ]);
    // Chaque exo est relié à la notion qui regroupe son libellé brut.
    const linked = await q.all<{ topic: string; label: string }>(`SELECT DISTINCT e.topic AS topic, t.label AS label FROM exam_exercises e JOIN topics t ON t.id = e.topic_id ORDER BY e.topic`);
    const expected = CLUSTERS.flatMap((c) => c.members.map((m) => [m, c.label])).sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(linked.map((r) => [r.topic, r.label]).sort((a, b) => a[0].localeCompare(b[0])), expected);
    assert.equal((await q.all(`SELECT id FROM exam_exercises WHERE topic_id IS NULL`)).length, 0);

    // Rattachement imposé : lecture hors plan → non rattachée ; notion absente de la table → chapitre gardé.
    const map = await mapNotionsToChapters({ lectureByLabel: new Map<string, number | null>([["k-Nearest Neighbors", 5], ["Generalization & Overfitting", 6], ["PCA", 42]]) });
    assert.deepEqual([map.ok, map.mapped, map.total], [true, 3, 4]);
    const placed = await q.all<{ label: string; lecture_no: number | null }>(`SELECT t.label AS label, c.lecture_no AS lecture_no FROM topics t LEFT JOIN plan_chapters c ON c.id = t.plan_chapter_id ORDER BY t.label`);
    assert.deepEqual(placed.map((r) => [r.label, r.lecture_no]), [["Decision trees", 5], ["Generalization & Overfitting", 6], ["PCA", null], ["k-Nearest Neighbors", 5]]);

    assert.deepEqual(await exosSnapshot(), exos, "les exos ne changent pas (seul topic_id est relié)");
    assert.deepEqual(await chaptersSnapshot(), chapters, "le plan n'est pas réécrit");
  });
});
