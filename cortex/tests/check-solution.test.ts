import assert from "node:assert/strict";
import test from "node:test";
import { parseCheckResult } from "../lib/check-solution";

const valid = {
  verdict: "partial",
  feedback: "La mise en équation est juste, mais le calcul final manque.",
  correct_solution: "On pose 2x = 8, donc x = 4.",
  criteria: [
    { label: "Pose correctement l’équation 2x = 8", points: 2, achieved: true, essential: true, justification: "L’équation apparaît dans la réponse." },
    { label: "Obtient x = 4", points: 1, achieved: false, essential: false, justification: "La valeur finale n’est pas donnée." },
  ],
};

test("le barème valide est parsé et son score est calculé", () => {
  assert.deepEqual(parseCheckResult(JSON.stringify(valid)), {
    ...valid,
    score: { earned: 2, total: 3 },
  });
});

test("un ancien JSON sans barème reçoit un repli cohérent", () => {
  const result = parseCheckResult(JSON.stringify({
    verdict: "partial",
    feedback: "Bonne démarche, résultat incomplet.",
    correct_solution: "Le résultat est 4.",
  }));
  assert.equal(result.criteria.length, 2);
  assert.deepEqual(result.score, { earned: 1, total: 2 });
  assert.equal(result.verdict, "partial");
});

test("un barème invalide reçoit le même repli propre", () => {
  const result = parseCheckResult(JSON.stringify({ ...valid, criteria: [{ label: "Résultat", points: 0, achieved: true, justification: "Oui." }] }));
  assert.equal(result.criteria.length, 2);
  assert.deepEqual(result.score, { earned: 1, total: 2 });
});

test("un verdict incohérent avec le score est rejeté vers le repli", () => {
  const result = parseCheckResult(JSON.stringify({ ...valid, verdict: "correct" }));
  assert.equal(result.verdict, "correct");
  assert.deepEqual(result.score, { earned: 2, total: 2 });
  assert.ok(result.criteria.every((criterion) => criterion.achieved));
});
