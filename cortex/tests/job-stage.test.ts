/**
 * L'ÉTAPE D'UNE GÉNÉRATION DITE À L'ÉTUDIANT (lib/job-stage) — l'interface affichait les phrases
 * de travail du moteur (« architecte · moules + idées fausses », « QCM rejeté : clé contestée… »).
 * Chaque phrase réelle du moteur (corpus du banc, contenu de cours retiré) doit tomber dans une
 * étape stable, ou être reconnue comme une ligne qui ne dit rien de l'avancement.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { classifyStep, stageTracker, STAGES } from "@/lib/job-stage";

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/job-steps.json"), "utf8")) as { type: string; step: string }[];

/** Lignes sans étape attendues : fin, mesure de phase, avertissement de manque, file. */
const SILENT = /^(Terminé|Examen.* prêt|Mock QCM|⏱|⚠|Annulé|En file|Worker interrompu)/u;

test("toute phrase réelle du moteur a une étape, sauf les lignes de fin, de mesure ou de file", () => {
  const unclassified = corpus.filter((x) => !classifyStep(x.type, x.step) && !SILENT.test(x.step));
  assert.deepEqual(unclassified, []);
});

test("les phrases qui inquiétaient tombent dans une étape neutre", () => {
  const cases: [string, string, string][] = [
    ["qcm", "Génération de 4 QCM (architecte · moules + idées fausses)…", "write"],
    ["qcm", "Vérification à l'aveugle des QCM (résolution indépendante, figures vues)…", "check"],
    ["qcm", "QCM rejeté : clé contestée : le correcteur trouve « … »", "check"],
    ["exam", "Question composée 1 rejetée : (a) distracteurs éliminables sans le cours : « … »", "check"],
    ["exam", "Lot 2 · Vérif 1/2 — « Cours — Part 2 » : ok", "check"],
    ["qcm", "4 QCM manquant(s) → 1 lot(s) de comblement", "refill"],
    ["qcm", "Revue finale : clés, hors-cours, distracteurs et doublons contrôlés en un appel", "review"],
    ["qcm", "Faits testables du cours : extraction sur 37 notions (5 appel(s))…", "plan"],
    ["exam", "Rendu du PDF (énoncé + corrigé)…", "render"],
    ["prepare", "Ingestion (contenu + annales)…", "read"],
    ["prepare", "Format : lecture des annales…", "format"],
    ["prepare", "Blueprint : Classification des exercices par type via le LLM (+ vision)…", "program"],
    ["prepare", "Format détecté — index exo-par-exo des finals…", "program"],
    ["exam", "Pré-vérifications…", "plan"],
  ];
  for (const [type, step, stage] of cases) assert.equal(classifyStep(type, step)?.stage, stage, step);
  assert.ok(cases.every(([, , s]) => (STAGES as readonly string[]).includes(s)));
});

test("compteurs : QCM construits, exercices de l'écrit (pas ses lots), version d'une question reprise", () => {
  assert.deepEqual(classifyStep("qcm", "11/20 QCM construits + vérifiés…"), { stage: "write", done: 11, total: 20, unit: "qcm" });
  // Écrit : les lots tournent en parallèle, « lot 2/3 » ne disait rien ; l'étape compte les exercices.
  assert.deepEqual(classifyStep("exam", "Lot 2/3 : génération de 2 exercices…"), { stage: "write" });
  assert.deepEqual(classifyStep("exam", "3/6 exercices rédigés ✓ (lot 2/3, 120s)"), { stage: "write", done: 3, total: 6, unit: "exercise" });
  assert.deepEqual(classifyStep("exam", "Architecte : 2/6 exercices construits"), { stage: "write", done: 2, total: 6, unit: "exercise" });
  assert.deepEqual(classifyStep("exam", "Lot 2/3 : vérification à l'aveugle + durcissement (1/6 exercices vérifiés)…"), { stage: "check", done: 1, total: 6, unit: "exercise" });
  assert.deepEqual(classifyStep("exam", "4/6 exercices vérifiés ✓ (lot 2/3, 384s)"), { stage: "check", done: 4, total: 6, unit: "exercise" });
  assert.deepEqual(classifyStep("exam", "2/6 exercices repris du checkpoint (lot 1/3)"), { stage: "write", done: 2, total: 6, unit: "exercise" });
  assert.equal(classifyStep("exam", "Question composée 4/7 (version 2) : Q4…")?.version, 2);
});

test("suivi : une ligne sans étape garde la précédente, le compteur de QCM traverse la boucle", () => {
  const track = stageTracker("qcm");
  assert.equal(track("Faits testables du cours : extraction sur 12 notions (3 appel(s))…")?.stage, "plan");
  assert.equal(track("⏱ Faits testables : 3 min 51 s")?.stage, "plan");
  assert.deepEqual(track("8/20 QCM construits + vérifiés…"), { key: "stage", stage: "write", done: 8, total: 20, unit: "qcm" });
  // Vérification du lot suivant : le compte des QCM déjà prêts reste affiché.
  assert.deepEqual(track("Vérification à l'aveugle des QCM (résolution indépendante, figures vues)…"), { key: "stage", stage: "check", done: 8, total: 20, unit: "qcm" });
  assert.equal(track("Revue finale : clés, hors-cours, distracteurs et doublons contrôlés en un appel")?.done, undefined);
});

test("écrit : le compte des exercices vérifiés reste pendant la vérification, ne passe pas à la rédaction", () => {
  const track = stageTracker("exam");
  assert.deepEqual(track("3/6 exercices rédigés ✓ (lot 1/2, 90s)"), { key: "stage", stage: "write", done: 3, total: 6, unit: "exercise" });
  assert.deepEqual(track("Lot 1/2 : vérification à l'aveugle + durcissement (0/6 exercices vérifiés)…"), { key: "stage", stage: "check", done: 0, total: 6, unit: "exercise" });
  assert.deepEqual(track("Lot 1 · Vérif 1/3 — « Cours — Part 2 » : ok"), { key: "stage", stage: "check", done: 0, total: 6, unit: "exercise" });
  // Les lots tournent en parallèle : celui qui s'écrit encore ne ramène pas le suivi à la rédaction
  // (banc du 25/11 : « Vérification · 2/4 exercices prêts » puis « Rédaction · 4/4 exercices prêts »).
  const checking = { key: "stage", stage: "check", done: 0, total: 6, unit: "exercise" };
  assert.deepEqual(track("Lot 2/2 : génération de 3 exercices…"), checking, "un lot encore en rédaction ne fait pas reculer l'étape");
  assert.deepEqual(track("6/6 exercices rédigés ✓ (lot 2/2, 120s)"), checking, "les exercices rédigés ne se lisent pas comme vérifiés");
  assert.deepEqual(track("3/6 exercices vérifiés ✓ (lot 1/2, 130s)"), { ...checking, done: 3 });
  assert.deepEqual(track("Lot 2 · Vérif 1/3 — « Réseaux » : ok"), { ...checking, done: 3 });
  assert.deepEqual(track("Compilation du PDF (LaTeX)…"), { key: "stage", stage: "render" });
});

test("questions composées : le compte vient des questions prêtes, pas de la dernière commencée", () => {
  const track = stageTracker("exam");
  assert.deepEqual(track("Question composée 3/7 : Q3 — théorie…"), { key: "stage", stage: "write", done: 0, total: 7, unit: "question" });
  assert.deepEqual(track("Question composée 1 rejetée : (a) distracteurs éliminables sans le cours : A ; B"), { key: "stage", stage: "check", done: 0, total: 7, unit: "question" });
  assert.deepEqual(track("2/7 questions composées prêtes"), { key: "stage", stage: "check", done: 2, total: 7, unit: "question" });
  assert.deepEqual(track("Question composée 5/7 (version 2) : Q5…"), { key: "stage", stage: "write", done: 2, total: 7, unit: "question", version: 2 });
  assert.deepEqual(track("Question composée 2 refaite : elle reprenait la question 4 (biais)"), { key: "stage", stage: "refill", done: 2, total: 7, unit: "question" });
  assert.deepEqual(track("Rendu du PDF (énoncé + corrigé)…"), { key: "stage", stage: "render" });
});
