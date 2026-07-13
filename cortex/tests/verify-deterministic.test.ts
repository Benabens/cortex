import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sympyAvailable,
  verifyBoolean,
  verifyDeterministic,
  verifyMcq,
  verifyNumericPlain,
  verifyStructural,
  verifySymbolic,
} from "../lib/verify-deterministic";

/**
 * Juge déterministe (Phase D) — fixtures façon « éval smoke » : verrouille le
 * comportement du vérificateur (l'invariant « jamais de faux prouvé » d'abord).
 * Tourne partout (aucun LLM, sympy optionnel — les cas symboliques sont dans
 * sandbox-exec.test / CI installe sympy).
 */

test("mcq : lettres exactes, ensembles, désordre", () => {
  assert.equal(verifyMcq("B", "B").verified, true);
  assert.equal(verifyMcq("A, C", "C et A").verified, true);
  assert.equal(verifyMcq("B", "C").verified, false);
  assert.equal(verifyMcq("la réponse dépend", "B").verified, "not_applicable");
});

test("numeric : le DERNIER nombre fait foi (anti faux-prouvé)", () => {
  assert.equal(verifyNumericPlain("on calcule 12 puis 24, donc RÉPONSE : 42", "42").verified, true);
  // un intermédiaire coïncide mais la réponse finale diffère → AMBIGU, pas prouvé
  assert.equal(verifyNumericPlain("on obtient 42 puis on corrige : 40", "42").verified, "not_applicable");
  assert.equal(verifyNumericPlain("le résultat est 40", "42").verified, false);
  assert.equal(verifyNumericPlain("aucun nombre ici", "42").verified, "not_applicable");
});

test("numeric : tolérance relative + virgule décimale + fraction", () => {
  assert.equal(verifyNumericPlain("≈ 3,1416", "3.1415").verified, true);
  assert.equal(verifyNumericPlain("la probabilité vaut 3/4", "0.75").verified, true);
  assert.equal(verifyNumericPlain("réponse : 0.75", "3/4").verified, true);
});

test("boolean : vrai/faux multilingues", () => {
  assert.equal(verifyBoolean("Vrai — car le cache est actif.", "true").verified, true);
  assert.equal(verifyBoolean("False", "vrai").verified, false);
  assert.equal(verifyBoolean("ça dépend", "vrai").verified, "not_applicable");
  assert.equal(verifyBoolean("Non.", "no").verified, true);
});

test("structural : séquences strictes ; ensembles stricts sinon non-concluant", () => {
  assert.equal(verifyStructural("1, 5, 3, 2", "1 5 3 2").verified, true);
  assert.equal(verifyStructural("1, 3, 5, 2", "1 5 3 2").verified, false);
  assert.equal(verifyStructural("{a, b, c}", "{c, b, a}").verified, true);
  // ensembles différents → plusieurs solutions valides possibles → PAS un faux réfuté
  assert.equal(verifyStructural("{a, d}", "{a, b}").verified, "not_applicable");
});

test("symbolic (sympy, sandboxé si dispo) : C(n,2), asymptotique, réfutation", async (t) => {
  if (!(await sympyAvailable())) return t.skip("sympy absent — voie symbolique = not_applicable (contrat testé ailleurs)");
  assert.equal((await verifySymbolic("n(n-1)/2", "C(n,2)")).verified, true);
  assert.equal((await verifySymbolic("Θ(n^2)", "n^{log_3 9}", { asymptotic: true })).verified, true);
  assert.equal((await verifySymbolic("n^2", "n^3")).verified, false);
});

test("dispatch : open → LLM ; short booléen prioritaire ; code sans tests → NA", async () => {
  assert.equal((await verifyDeterministic("peu importe", "réf", "open")).verified, "not_applicable");
  const b = await verifyDeterministic("Vrai, le TTL est de 1h.", "vrai", "short");
  assert.equal(b.method, "boolean");
  assert.equal(b.verified, true);
  const c = await verifyDeterministic("print(1)", "réf", "code", { tests: [] });
  assert.equal(c.verified, "not_applicable");
});
