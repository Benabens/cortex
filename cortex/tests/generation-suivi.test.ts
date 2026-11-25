/**
 * SUIVI D'UNE GÉNÉRATION (lib/ux/generation) — audit generation-ux du 24/11/2026 : la barre
 * reculait quand le moteur ajoutait un lot de reprise, le temps restant manquait ou était faux,
 * la pastille ne savait pas où ramener l'étudiant. Règles pures de l'interface de suivi.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { barValue, cancelOutcome, elapsedMinutes, finishedHref, launchedFromApp, measuredProgress, orbStateFor, pageOfJob, questionOfTarget, rangeText } from "@/lib/ux/generation";
import { STAGES } from "@/lib/job-stage";

const MIN = 60_000;

test("chaque étape du moteur a son état d'orbe (aucune ne retombe sur l'état générique)", () => {
  for (const stage of STAGES) assert.notEqual(orbStateFor({ type: "exam", status: "running", stepInfo: { key: "stage", stage } }), "working", stage);
});

test("la barre ne recule jamais pour un même job, repart à zéro pour un autre", () => {
  let prev = { id: 7, value: barValue(null, { id: 7, status: "running", progress: 64 }) };
  assert.equal(prev.value, 64);
  prev = { id: 7, value: barValue(prev, { id: 7, status: "running", progress: 52 }) };
  assert.equal(prev.value, 64, "un lot de reprise ne fait pas reculer la barre");
  assert.equal(barValue(prev, { id: 8, status: "running", progress: 5 }), 5);
  assert.equal(barValue(null, { id: 9, status: "queued", progress: 0 }), 2, "en file : un trait, jamais une barre vide");
});

test("fourchette : englobante, jamais « 0 à 1 min », bornes égales = environ", () => {
  assert.deepEqual(rangeText(5.5 * MIN, 11.2 * MIN), { kind: "range", low: 5, high: 12 });
  assert.deepEqual(rangeText(10_000, 50_000), { kind: "under" });
  assert.deepEqual(rangeText(20_000, 90_000), { kind: "range", low: 1, high: 2 });
  assert.deepEqual(rangeText(3 * MIN, 3 * MIN), { kind: "about", minutes: 3 });
  assert.equal(rangeText(null, null), null);
});

test("temps écoulé lu sur l'horodatage SQL en UTC", () => {
  const now = Date.parse("2026-11-24T18:10:30Z");
  assert.equal(elapsedMinutes("2026-11-24 18:04:00", now), 6);
  assert.equal(elapsedMinutes("2026-11-24T18:04:00Z", now), 6);
  assert.equal(elapsedMinutes(undefined, now), null);
});

test("orbe : respire en file, suit l'étape, un seul état si on le demande", () => {
  assert.equal(orbStateFor(null), "breathing");
  assert.equal(orbStateFor({ type: "exam", status: "queued", stepInfo: null }), "breathing");
  assert.equal(orbStateFor({ type: "qcm", status: "running", stepInfo: { key: "stage", stage: "write" } }), "composing");
  assert.equal(orbStateFor({ type: "qcm", status: "verifying", stepInfo: { key: "stage", stage: "check" } }), "solving");
  assert.equal(orbStateFor({ type: "check", status: "running", stepInfo: null }), "solving");
});

test("page d'une génération, et ce que garde une annulation", () => {
  assert.equal(pageOfJob("qcm", "cs 202"), "/examens?course=cs%20202");
  assert.equal(pageOfJob("prepare", "ml"), "/sources?course=ml");
  assert.equal(pageOfJob("check", "ml"), null);
  assert.equal(cancelOutcome({ type: "exam", progress: 8, resultId: null }), "refunded");
  assert.equal(cancelOutcome({ type: "exam", progress: 40, resultId: null }), "notRefunded");
  assert.equal(cancelOutcome({ type: "qcm", progress: 60, resultId: 12 }), "keepsReady");
  // Propriétaire, facturation coupée : pas de crédits à promettre.
  assert.equal(cancelOutcome({ type: "exam", progress: 8, resultId: null, charged: false }), "free");
  assert.equal(cancelOutcome({ type: "qcm", progress: 60, resultId: 12, charged: false }), "keepsReadyFree");
});

test("exercice ciblé et correction (jobs de l'app) : leur page, le lien de fin, une barre sans pourcentage", () => {
  const question = questionOfTarget(JSON.stringify({ statement: "…", answer: "2", question: { examId: 7, questionId: 3 }, from: "web" }));
  assert.deepEqual(question, { examId: 7, questionId: 3 });
  assert.equal(questionOfTarget(JSON.stringify({ question: { examId: "7", questionId: 3 } })), null);
  assert.equal(questionOfTarget("pas du JSON"), null);
  assert.equal(questionOfTarget(null), null);
  // Une aide d'assistant (MCP) n'a pas de marque : la page ne la reprend pas.
  assert.equal(launchedFromApp(JSON.stringify({ concept: "Récursion", from: "web" })), true);
  assert.equal(launchedFromApp(JSON.stringify({ concept: "Récursion" })), false);
  assert.equal(launchedFromApp("{"), false);
  // La pastille ramène à la question corrigée ; sans question (assistant), aucune page.
  assert.equal(pageOfJob("check", "ml", question), "/mock/7?course=ml");
  assert.equal(pageOfJob("drill", "ml"), "/entrainement?course=ml");
  // La notification de fin ouvre le résultat lui-même : la page le relit par son job.
  assert.equal(finishedHref({ type: "drill", course: "ml", id: 12, status: "done", resultPath: null }), "/entrainement?course=ml&job=12");
  assert.equal(finishedHref({ type: "check", course: "cs 202", id: 55, status: "done", resultPath: null, question }), "/mock/7?course=cs%20202&job=55");
  assert.equal(finishedHref({ type: "check", course: "ml", id: 55, status: "failed", resultPath: null, question }), "/mock/7?course=ml");
  assert.equal(finishedHref({ type: "exam", course: "ml", id: 9, status: "done", resultPath: "/mock/3" }), "/mock/3?course=ml");
  assert.equal(finishedHref({ type: "exam", course: "ml", id: 9, status: "done", resultPath: "/api/exams/3/pdf" }), "/api/exams/3/pdf");
  assert.equal(finishedHref({ type: "exam", course: "ml", id: 9, status: "failed", resultPath: null }), "/examens?course=ml");
  // Un seul appel au modèle : l'avancement ne mesure rien, la barre ne montre pas de pourcentage.
  assert.equal(measuredProgress("exam"), true);
  assert.equal(measuredProgress("drill"), false);
  assert.equal(measuredProgress("check"), false);
});
