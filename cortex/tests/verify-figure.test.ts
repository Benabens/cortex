import test from "node:test";
import assert from "node:assert/strict";
import { verifyDeterministic } from "../lib/verify-deterministic";

/**
 * moteur-v2 (P4) — contrat du vérifieur déterministe « figure » :
 * preuve = réponse candidate == valeur VÉRITÉ déclarée par la spec (calculée au rendu).
 * JAMAIS de faux « prouvé » : 0 ou >1 vérités, vérité non numérique → not_applicable.
 * Hermétique (aucun rendu ici — la vérité est fournie ; le rendu réel est testé dans figure-gen).
 */

test("figure : réponse == vérité unique → PROUVÉ (last-number-wins)", async () => {
  const r = await verifyDeterministic("Je compte les points du groupe A : 12", "", "figure", { figureTruth: { nA: 12 } });
  assert.equal(r.verified, true);
  assert.equal(r.method, "figure");
});

test("figure : réponse ≠ vérité → RÉFUTÉ (false, pas NA)", async () => {
  const r = await verifyDeterministic("Il y en a 9", "", "figure", { figureTruth: { nA: 12 } });
  assert.equal(r.verified, false);
  assert.equal(r.method, "figure");
});

test("figure : tolérance relative (valeurs continues lues sur un graphe)", async () => {
  const r = await verifyDeterministic("x* ≈ 3.1416", "", "figure", { figureTruth: { xStar: 3.14159265 } });
  assert.equal(r.verified, true);
});

test("figure : JAMAIS de faux prouvé — 0 vérité, >1 vérités, vérité non finie → NA", async () => {
  assert.equal((await verifyDeterministic("12", "", "figure", { figureTruth: {} })).verified, "not_applicable");
  assert.equal((await verifyDeterministic("12", "", "figure", { figureTruth: { a: 1, b: 2 } })).verified, "not_applicable");
  assert.equal((await verifyDeterministic("12", "", "figure", { figureTruth: { a: NaN } })).verified, "not_applicable");
  assert.equal((await verifyDeterministic("12", "", "figure")).verified, "not_applicable");
});

test("figure : sans réponse candidate → NA (jamais un verdict au hasard)", async () => {
  const r = await verifyDeterministic("", "", "figure", { figureTruth: { nA: 12 } });
  assert.equal(r.verified, "not_applicable");
});
