import assert from "node:assert/strict";
import test from "node:test";
import { scoreQcmAnswer } from "../lib/qcm";

test("un QCM à choix unique reste noté en tout-ou-rien", () => {
  assert.equal(scoreQcmAnswer([1], [1], 4), 1);
  assert.equal(scoreQcmAnswer([1], [2], 4), 0);
});

test("un QCM multiple exact vaut un point", () => {
  assert.equal(scoreQcmAnswer([0, 2], [2, 0], 4), 1);
});

test("la moitié des bonnes réponses sans erreur vaut un demi-point", () => {
  assert.equal(scoreQcmAnswer([0, 2], [0], 4), 0.5);
});

test("cocher toutes les cases d'un QCM multiple vaut zéro", () => {
  assert.equal(scoreQcmAnswer([0, 2], [0, 1, 2, 3], 4), 0);
});

test("ne cocher aucune case vaut zéro", () => {
  assert.equal(scoreQcmAnswer([0, 2], [], 4), 0);
});
