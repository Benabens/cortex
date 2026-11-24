/**
 * RELECTURE DES AIDES (lib/assist-review) — banc du 23/11/2026 : un drill sur treize sortait avec un
 * corrigé faux (Opus 5.5, effort moyen) ; ni le drill ni check_answer n'avaient de contrôle, le même
 * appel inventait l'exercice et sa solution, ou corrigeait l'étudiant en lisant sa réponse.
 *  - drill : re-résolution sans le corrigé, comparaison, UNE réécriture en cas de désaccord ;
 *  - check_answer : re-résolution sans la réponse de l'étudiant, en parallèle de la correction,
 *    puis comparaison ; une correction faite contre une solution fausse est refaite.
 * Interrupteurs (lib/verif-switches) : CORTEX_CHECK_REVIEW (actif par défaut), CORTEX_DRILL_REVIEW
 * (coupé par défaut) ; les tests du drill l'activent.
 * Fournisseur simulé (openai-compatible) : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-aides-relecture-"));
const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: tmp, LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "test", LLM_MODEL_OPUS: "claude-sonnet-5", LLM_MAX_RETRIES: "0",
};
Object.assign(process.env, ENV);

const DRILL = {
  concept: "Flot maximal",
  statement_html: "<p>Réseau s→a (8), s→b (3), a→t (6), b→t (7), a→b (4). Flot maximal de s à t ?</p>",
  hints: ["Ford-Fulkerson.", "Chemin augmentant.", "Commence par s→a→t.", "Regarde a→b.", "Après s→a→t (6), s→a→b→t (2)."],
  solution_html: "<ol><li>s→a→t : 6.</li><li>s→a→b→t : 2.</li><li>s→b→t : 3.</li><li>Flot maximal : 6 + 2 + 3 = 12.</li></ol>",
  course_terms: [],
};
const FIXED_SOLUTION = "<ol><li>s→a→t : 6.</li><li>s→a→b→t : 2.</li><li>s→b→t : 3.</li><li>Flot maximal : 6 + 2 + 3 = 11 (coupe {s→a, s→b} = 11).</li></ol>";

const CHECK = (solution: string, verdict: string) => JSON.stringify({
  verdict, feedback: verdict === "correct" ? "Rien à redire." : "Le résultat est faux.", correct_solution: solution,
  criteria: [
    { label: "Trouve les chemins augmentants", points: 1, achieved: true, essential: true, justification: "Oui." },
    { label: "Donne la valeur du flot", points: 1, achieved: verdict === "correct", essential: false, justification: "Comparée à la solution." },
  ],
});

/** Réponses du faux modèle, selon l'appel. */
let onBlind: (prompt: string) => string = () => "Chemins 6, 2, 3. RÉPONSE FINALE : 11. HYPOTHÈSES : aucune";
let onDrillReview: (prompt: string) => object = () => ({ verdict: "agree", issue: "" });
let onCheckReview: (prompt: string) => object = () => ({ agree: true, issue: "" });
let checkAnswer = CHECK("Flot maximal : 11.", "correct");
const prompts: { kind: string; text: string; at: number }[] = [];
let server: http.Server;

before(async () => {
  delete process.env.CORTEX_USER;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const text = (JSON.parse(body) as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n");
      let kind = "other";
      let out = "{}";
      if (/RÉSOLUTION INDÉPENDANTE d'un exercice d'entraînement/.test(text)) { kind = "blind"; out = onBlind(text); }
      else if (/CONTRÔLE D'UNE PREMIÈRE CORRECTION/.test(text)) { kind = "check-review"; out = JSON.stringify(onCheckReview(text)); }
      else if (/Tu contrôles un exercice d'entraînement/.test(text)) { kind = "drill-review"; out = JSON.stringify(onDrillReview(text)); }
      else if (/VOICI LA QUESTION D'EXAMEN/.test(text)) { kind = "check"; out = checkAnswer; }
      else if (/UNE seule question d'entraînement/.test(text)) { kind = "drill"; out = JSON.stringify(DRILL); }
      prompts.push({ kind, text, at: Date.now() });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: out }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => {
  prompts.length = 0;
  delete process.env.CORTEX_CHECK_REVIEW;
  process.env.CORTEX_DRILL_REVIEW = "1";
  onBlind = () => "Chemins 6, 2, 3. RÉPONSE FINALE : 11. HYPOTHÈSES : aucune";
  onDrillReview = () => ({ verdict: "agree", issue: "" });
  onCheckReview = () => ({ agree: true, issue: "" });
  checkAnswer = CHECK("Flot maximal : 11.", "correct");
});

after(async () => {
  await new Promise((r) => server.close(r));
  for (const k of [...Object.keys(ENV), "LLM_BASE_URL", "CORTEX_CHECK_REVIEW", "CORTEX_DRILL_REVIEW"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function drill() {
  const { runWithCourse } = await import("../db/client");
  const { generateDrill } = await import("../lib/drill");
  return runWithCourse("ml", () => generateDrill("Flot maximal"));
}

async function check(answer: string) {
  const { runWithCourse } = await import("../db/client");
  const { checkSolution } = await import("../lib/check-solution");
  return runWithCourse("ml", () => checkSolution({ statement: DRILL.statement_html, answer }));
}

test("drill : la re-résolution ne voit pas le corrigé, la comparaison reçoit les deux et l'égalité fausse recalculée", async () => {
  await drill();
  const blind = prompts.find((p) => p.kind === "blind")?.text ?? "";
  const review = prompts.find((p) => p.kind === "drill-review")?.text ?? "";
  assert.match(blind, /s→a \(8\)/, "la re-résolution reçoit l'énoncé");
  assert.doesNotMatch(blind, /6 \+ 2 \+ 3/, "ni le corrigé proposé");
  assert.doesNotMatch(blind, /Après s→a→t/, "ni les indices");
  assert.match(review, /RÉPONSE FINALE : 11/);
  assert.match(review, /égalité fausse : « 6 \+ 2 \+ 3 = 12 » \(le recalcul donne 11\)/);
});

test("drill au corrigé faux : réécrit une fois (corrigé et indices), énoncé gardé", async () => {
  const hints = ["Ford-Fulkerson.", "Chemin augmentant.", "Commence par s→a→t.", "Regarde a→b.", "La coupe {s→a, s→b} borne le flot."];
  onDrillReview = () => ({ verdict: "fix", issue: "6 + 2 + 3 = 11, pas 12", solution_html: FIXED_SOLUTION, hints });
  const d = await drill();
  assert.equal(d.solution_html, FIXED_SOLUTION);
  assert.deepEqual(d.hints, hints);
  assert.equal(d.statement_html, DRILL.statement_html);
  assert.equal(prompts.filter((p) => p.kind === "drill-review").length, 1, "une seule réécriture");
});

test("drill : une relecture d'accord, illisible ou incomplète laisse le drill tel quel", async () => {
  assert.equal((await drill()).solution_html, DRILL.solution_html);
  onDrillReview = () => ({ verdict: "fix", issue: "faux", solution_html: "" });
  assert.equal((await drill()).solution_html, DRILL.solution_html, "réécriture vide : rien n'est remplacé");
  onBlind = () => "";
  const d = await drill();
  assert.equal(d.solution_html, DRILL.solution_html, "re-résolution vide : drill livré sans comparaison");
  assert.equal(prompts.filter((p) => p.kind === "drill-review").length, 2);
});

test("check_answer : la re-résolution ne voit pas la réponse de l'étudiant et part en parallèle de la correction", async () => {
  await check("Je trouve 11 avec trois chemins augmentants.");
  const blind = prompts.find((p) => p.kind === "blind");
  const grade = prompts.find((p) => p.kind === "check");
  assert.ok(blind && grade);
  assert.doesNotMatch(blind.text, /Je trouve 11/, "la re-résolution ignore la réponse de l'étudiant");
  assert.ok(Math.abs(blind.at - grade.at) < 1_000, "lancées ensemble, pas l'une après l'autre");
  assert.equal(prompts.filter((p) => p.kind === "check-review").length, 1);
});

test("check_answer corrigé contre une solution fausse : la correction refaite remplace la première", async () => {
  // Le premier correcteur trouve 12 et juge faux un étudiant qui a raison (11).
  checkAnswer = CHECK("Flot maximal : 6 + 2 + 3 = 12.", "partial");
  onCheckReview = () => ({ agree: false, issue: "la somme vaut 11", ...JSON.parse(CHECK("Flot maximal : 11.", "correct")) });
  const r = await check("11");
  assert.match(prompts.find((p) => p.kind === "check-review")?.text ?? "", /égalité fausse : « 6 \+ 2 \+ 3 = 12 »/);
  assert.equal(r.verdict, "correct");
  assert.equal(r.correct_solution, "Flot maximal : 11.");
  assert.deepEqual(r.score, { earned: 2, total: 2 });
});

test("check_answer : un désaccord sans correction complète garde la première", async () => {
  onCheckReview = () => ({ agree: false, issue: "doute" });
  assert.equal((await check("11")).verdict, "correct");
  assert.ok(prompts.some((p) => p.kind === "check-review"), "la relecture a bien eu lieu");
});

const kinds = () => prompts.map((p) => p.kind).sort();

test("interrupteurs par défaut : check_answer relu, drill livré sans relecture", async () => {
  delete process.env.CORTEX_CHECK_REVIEW;
  delete process.env.CORTEX_DRILL_REVIEW;
  await check("11");
  assert.deepEqual(kinds(), ["blind", "check", "check-review"], "check_answer : re-résolution et comparaison");
  prompts.length = 0;
  const d = await drill();
  assert.deepEqual(kinds(), ["drill"], "drill : aucun appel de relecture");
  assert.equal(d.solution_html, DRILL.solution_html, "drill livré tel quel");
});

test("CORTEX_CHECK_REVIEW=0 coupe la relecture de check_answer", async () => {
  process.env.CORTEX_CHECK_REVIEW = "0";
  await check("11");
  assert.deepEqual(kinds(), ["check"]);
});

test("CORTEX_DRILL_REVIEW=1 active la relecture du drill, toute autre valeur la laisse coupée", async () => {
  process.env.CORTEX_DRILL_REVIEW = "1";
  await drill();
  assert.deepEqual(kinds(), ["blind", "drill", "drill-review"]);
  for (const v of ["0", "true", ""]) {
    prompts.length = 0;
    process.env.CORTEX_DRILL_REVIEW = v;
    await drill();
    assert.deepEqual(kinds(), ["drill"], `CORTEX_DRILL_REVIEW=${JSON.stringify(v)}`);
  }
});
