/**
 * Banc moteur du 04/11/2026 : 4 explications sur 28 (synth-3p) et 3 rejets sur 5 (CS-290)
 * désignaient une option par son rang (« c'est la première proposition qui est correcte »).
 * Chacune était rejetée puis régénérée — appels et minutes perdus. Le moteur les réécrit
 * désormais AVANT le mélange des options, en citant le contenu de l'option désignée ; ce
 * qu'il ne sait pas réécrire sans ambiguïté reste rejeté comme avant.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.CORTEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-option-refs-"));

const OPTS = ["Elle n'est pas stable", "Elle est stable", "Elle est instable au-delà de 0,5", "On ne peut pas conclure"];

test("rang de la bonne réponse : remplacé par son contenu, plus aucun renvoi par position", async () => {
  const { repairOptionRefs, citesOptionLabel } = await import("../lib/qcm");
  const out = repairOptionRefs("Le seuil est strict : c'est la première proposition qui est correcte.", OPTS, [0]);
  assert.equal(out, "Le seuil est strict : c'est la proposition « Elle n'est pas stable » qui est correcte.");
  assert.equal(citesOptionLabel(out!), false);
});

test("« la Nième option erronée » : la Nième des options fausses, dans l'ordre d'origine", async () => {
  const { repairOptionRefs } = await import("../lib/qcm");
  const out = repairOptionRefs("La première option erronée reprend par erreur l'exemple ; la deuxième option fausse inverse la condition.", OPTS, [1]);
  assert.equal(out, "L'option erronée « Elle n'est pas stable » reprend par erreur l'exemple ; l'option fausse « Elle est instable au-delà de 0,5 » inverse la condition.");
});

test("lettre d'option et anglais : remplacés par le contenu", async () => {
  const { repairOptionRefs, citesOptionLabel } = await import("../lib/qcm");
  assert.equal(repairOptionRefs("L'option C confond les deux seuils.", OPTS, [0]), "L'option « Elle est instable au-delà de 0,5 » confond les deux seuils.");
  const en = repairOptionRefs("The second option is wrong because the threshold is strict.", ["Not stable", "Stable", "Unstable", "Unknown"], [0]);
  assert.equal(en, "The option “Stable” is wrong because the threshold is strict.");
  assert.equal(citesOptionLabel(en!), false);
});

test("renvoi ambigu ou hors des options : pas de réécriture (le rejet actuel s'applique)", async () => {
  const { repairOptionRefs } = await import("../lib/qcm");
  assert.equal(repairOptionRefs("Les deux premières options sont fausses.", OPTS, [2]), null);
  assert.equal(repairOptionRefs("La cinquième option est juste.", OPTS, [0]), null);
  assert.equal(repairOptionRefs("Le seuil 0,39 est strict.", OPTS, [0]), "Le seuil 0,39 est strict.", "rien à réécrire : texte rendu tel quel");
});

test("un nombre entre parenthèses qui ne désigne aucune option n'est pas un renvoi (CS-290 : « row count (7) »)", async () => {
  const { citesOptionLabel } = await import("../lib/qcm");
  const fpr = "FN / (FN + TP) = 1/3. Dividing FN by the total row count (7) instead of by FN + TP gives the incorrect 0.14.";
  assert.equal(citesOptionLabel(fpr, 4), false, "4 options : (7) n'en désigne aucune");
  assert.equal(citesOptionLabel("La bonne réponse est (2), car le seuil est strict.", 4), true, "(2) désigne une option");
  assert.equal(citesOptionLabel("L'option (C) confond les seuils.", 4), true);
});
