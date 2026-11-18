import assert from "node:assert/strict";
import { createElement } from "react";
import { test } from "node:test";
import { ReportButton } from "../components/exam/ReportButton";
import { OpenResponse } from "../components/exam/OpenResponse";
import { ChapterAccordion } from "../components/programme/ChapterAccordion";
import { ProgramExplorer } from "../components/programme/ProgramExplorer";
import type { PlanChapterUi } from "../lib/ux/program";
import { renderIntl } from "./helpers/intl";

test("ProgramExplorer affiche son chrome en anglais et son contenu en français", () => {
  const html = renderIntl(createElement(ProgramExplorer, {
    types: [{ key: 1, title: "Algèbre linéaire", desc: "Valeurs propres", section: "Chapitre français", chapterId: null, count: 3, courseHref: null, courseOrder: 1, occurrences: [] }],
    chapters: [],
    planOk: false,
    language: "fr",
  }), "en");
  assert.match(html, /Organise topics/);
  assert.match(html, /lang="fr">Algèbre linéaire/);
  assert.doesNotMatch(html, /Organiser les notions|Par priorité|ordre indicatif/);
});

test("ChapterAccordion garde le contenu fictif français dans lang=fr", () => {
  const chapter: PlanChapterUi = {
    id: 4,
    lectureNo: 4,
    title: "Analyse numérique",
    subtitle: null,
    sourceHref: "/fake-course",
    notions: [{
      key: 9,
      title: "Méthode de Newton",
      desc: "Convergence quadratique",
      section: null,
      chapterId: 4,
      count: 2,
      courseHref: null,
      courseOrder: 1,
      occurrences: [],
    }],
    fallenCount: 1,
    occurrenceCount: 2,
  };
  const html = renderIntl(createElement(ChapterAccordion, { c: chapter, defaultOpen: true, language: "fr" }), "en");
  assert.match(html, /lang="fr">Analyse numérique/);
  assert.match(html, /lang="fr">Méthode de Newton/);
  // Les chiffres gardent leur style (spans) : la phrase se lit sans balises.
  assert.match(html.replace(/<[^>]+>/g, ""), /1 topic·1 in past exams/);
  assert.match(html, /<span class="font-data tabular text-ink-2">1<\/span> topic/);
  assert.doesNotMatch(html, /notion|tombée|Ouvrir la lecture/);
});

test("ReportButton affiche son action en anglais", () => {
  const html = renderIntl(createElement(ReportButton, { courseId: "fake", examId: 1, kind: "qcm", itemId: 2 }), "en");
  assert.match(html, />Report</);
  assert.doesNotMatch(html, /Signaler|Annuler|Envoyer/);
});

test("OpenResponse traduit le chrome et marque le corrigé fictif en français", () => {
  const html = renderIntl(createElement(OpenResponse, {
    questionId: 3,
    statement: "Démontrer la convergence de la suite.",
    courseId: "fake",
    graded: true,
    solution: "<p>La suite est croissante et majorée.</p>",
    language: "fr",
  }), "en");
  assert.match(html, /Your answer/);
  assert.match(html, /Check my answer/);
  assert.match(html, /lang="fr"><div[^>]*><p>La suite est croissante et majorée/);
  assert.doesNotMatch(html, /Ta réponse|Vérifier ma réponse|Corrigé/);
});
