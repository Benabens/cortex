import assert from "node:assert/strict";
import { test } from "node:test";
import { priorityOf, rankTopics, toNextUp, upNext } from "../lib/next-up";
import { chapterLine, examLine, reason, rowFacts, rowFactsSpoken, themeHref, trainHref } from "../lib/ux/next-up";
import type { ProgramOverview, TopicView } from "../lib/program";

/** Accueil « Next up » : le classement des notions suivantes, et des phrases qui n'inventent rien. */

const NOW = Date.parse("2026-10-13T12:00:00Z");
const PAST = "2026-10-01 08:00:00";
const FUTURE = "2026-11-01 08:00:00";

function topic(over: Partial<TopicView> & { id: number }): TopicView {
  return {
    label: `Notion ${over.id}`, method: null, exoType: null, trap: null, category: null, archetype: null,
    examWeight: 5, examCount: 3, source: "final", description: null, chapterId: null,
    mastery: null, attempts: 0, lastScore: null, lastDoneAt: null, lastExamId: null, dueAt: null,
    status: "never", occurrences: 0,
    ...over,
  };
}

const overview = (topics: TopicView[], chapters: ProgramOverview["chapters"] = []): ProgramOverview => ({
  topics, chapters, planOk: chapters.length > 0,
  stats: { total: topics.length, covered: 0, mastered: 0, due: 0, coveragePct: 0, masteryPct: 0 },
});

test("priorité : poids × écart de maîtrise × dû, comme nextTopic()", () => {
  assert.equal(priorityOf(topic({ id: 1, examWeight: 8 }), NOW), 8); // jamais vue
  assert.equal(priorityOf(topic({ id: 2, examWeight: 8, attempts: 2, mastery: 5, dueAt: PAST }), NOW), 4); // due
  assert.ok(Math.abs(priorityOf(topic({ id: 3, examWeight: 8, attempts: 2, mastery: 5, dueAt: FUTURE }), NOW) - 1.2) < 1e-9); // à jour
});

test("classement : les plus rentables d'abord, l'ordre d'entrée départage les égalités", () => {
  const ranked = rankTopics(
    [
      topic({ id: 1, examWeight: 4 }),
      topic({ id: 2, examWeight: 9, attempts: 3, mastery: 9, dueAt: FUTURE }), // lourde mais tenue et pas due
      topic({ id: 3, examWeight: 7 }),
      topic({ id: 4, examWeight: 7 }),
    ],
    NOW
  );
  assert.deepEqual(ranked.map((t) => t.id), [3, 4, 1, 2]);
});

test("« Ensuite » : trois notions au plus, sans celle du haut de page", () => {
  const o = overview([1, 2, 3, 4, 5].map((id) => topic({ id, examWeight: 10 - id })));
  assert.deepEqual(upNext(o, 1, 3, NOW).map((t) => t.id), [2, 3, 4]);
  assert.deepEqual(upNext(overview([topic({ id: 1 })]), 1, 3, NOW), []);
});

test("notion affichée : occurrences indexées sinon compte de l'analyse, chapitre du plan sinon null", () => {
  const chapters = [
    { id: 30, seq: 3, lectureNo: 3, title: "Linear Models", subtitle: null, summary: null, sourceHref: null, notionCount: 1, fallenCount: 1, occurrenceCount: 12 },
  ];
  assert.deepEqual(toNextUp(topic({ id: 1, label: "Logistic Regression", examCount: 9, occurrences: 12, chapterId: 30 }), chapters), {
    id: 1, label: "Logistic Regression", category: null, examWeight: 5, status: "never", mastery: null,
    count: 12, chapter: { lectureNo: 3, title: "Linear Models" },
  });
  const loose = toNextUp(topic({ id: 2, examCount: 4, occurrences: 0, chapterId: 99 }), chapters);
  assert.equal(loose.count, 4);
  assert.equal(loose.chapter, null);
});

test("ligne du final : à saisir, à venir, dépassé", () => {
  assert.deepEqual(examLine(null), { state: "missing", text: "Final :", action: "ajoute la date" });
  assert.deepEqual(examLine({ date: "2027-01-18", days: 97 }), { state: "upcoming", text: "Final dans 97 jours · 18 janv." });
  assert.equal(examLine({ date: "2027-01-18", days: 1 }).text, "Final demain · 18 janv.");
  assert.equal(examLine({ date: "2027-01-18", days: 0 }).text, "Final aujourd’hui · 18 janv.");
  assert.deepEqual(examLine({ date: "2026-06-16", days: -119 }), {
    state: "past", text: "Final passé le 16 juin :", action: "mets la date à jour",
  });
  assert.equal(examLine({ date: "pas-une-date", days: 3 }).state, "missing");
});

const sentence = (r: ReturnType<typeof reason>) => r.lead + r.strong + r.rest;
const facts = { count: 12, examWeight: 9.2, status: "never", mastery: null, chapter: null };

test("raison : les vrais chiffres, et la fin selon l'état réel de la notion", () => {
  assert.equal(sentence(reason(facts)), "Tombée 12 fois dans les finals, 9,2 % des questions, et tu ne l’as jamais travaillée.");
  assert.equal(reason(facts).strong, "12 fois");
  assert.equal(
    sentence(reason({ ...facts, status: "due", mastery: 6.5 })),
    "Tombée 12 fois dans les finals, 9,2 % des questions, et sa révision est due (6,5/10)."
  );
  assert.equal(
    sentence(reason({ ...facts, status: "ok", mastery: 4 })),
    "Tombée 12 fois dans les finals, 9,2 % des questions, et elle reste à revoir (4/10)."
  );
  assert.equal(
    sentence(reason({ ...facts, status: "ok", mastery: 8 })),
    "Tombée 12 fois dans les finals, 9,2 % des questions, et tu la tiens à 8/10."
  );
});

test("raison : un fait absent n'est pas remplacé par un zéro", () => {
  assert.equal(sentence(reason({ ...facts, examWeight: 0 })), "Tombée 12 fois dans les finals et tu ne l’as jamais travaillée.");
  assert.equal(sentence(reason({ ...facts, examWeight: NaN })), "Tombée 12 fois dans les finals et tu ne l’as jamais travaillée.");
});

test("raison : une notion jamais tombée n'a pas de part des finals, même si l'analyse lui donne un poids", () => {
  // cas réel (Algorithms, « Shortest Paths ») : issue des séries, poids estimé 12, aucune occurrence.
  const never = sentence(reason({ ...facts, count: 0, examWeight: 12 }));
  assert.equal(never, "Au programme, pas encore tombée dans les finals, et tu ne l’as jamais travaillée.");
  assert.doesNotMatch(never, /%|\b0 fois|NaN|undefined|—/);
  assert.equal(rowFacts({ count: 0, examWeight: 12, chapter: { lectureNo: 5, title: "x" } }), "L5 · au programme");
  assert.equal(rowFactsSpoken({ count: 0, examWeight: 12, chapter: null }), "au programme");
});

test("chapitre et marge d'une ligne « Ensuite »", () => {
  assert.equal(chapterLine({ lectureNo: 3, title: "Linear Models for Classification (Part 1)" }), "Chapitre L3 : Linear Models for Classification (Part 1).");
  assert.equal(chapterLine({ lectureNo: null, title: "Graphes" }), "Chapitre : Graphes.");
  assert.equal(chapterLine(null), null);
  assert.equal(chapterLine({ lectureNo: 4, title: "  " }), null);
  assert.equal(rowFacts({ count: 9, examWeight: 6.9, chapter: { lectureNo: 11, title: "x" } }), "L11 · tombé 9 fois · 6,9 %");
  assert.equal(rowFacts({ count: 18, examWeight: 13, chapter: null }), "tombé 18 fois · 13 %");
  assert.equal(rowFacts({ count: 0, examWeight: 0, chapter: null }), "au programme");
  // la version lue à voix haute dit les mêmes faits, sans abréviation
  assert.equal(
    rowFactsSpoken({ count: 9, examWeight: 6.9, chapter: { lectureNo: 11, title: "x" } }),
    "lecture 11, tombé 9 fois, 6,9 % des questions"
  );
  assert.equal(rowFactsSpoken({ count: 0, examWeight: 0, chapter: null }), "au programme");
});

test("liens : l'entraînement s'ouvre sur la notion, le thème sur son chapitre", () => {
  assert.equal(trainHref("SVM: Hard & Soft Margin"), "/entrainement?prefill=SVM%3A%20Hard%20%26%20Soft%20Margin");
  assert.equal(themeHref({ lectureNo: 3, title: "x" }), "/programme?chapitre=3");
  assert.equal(themeHref(null), "/programme");
});
