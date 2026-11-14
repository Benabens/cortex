/**
 * EXPLICATION QUI RÉFUTE UN DISTRACTEUR ABSENT — job 17 (14/11/2026, HUM-285, examen QCM #8) :
 * Q14 (4 options) réfutait en plus « affirmer qu'elle ramène le coût marginal à zéro » et « dire
 * qu'elle supprime les coûts fixes », deux options qui n'existaient pas ; Q1 évoquait une
 * « tokenisation » absente des options. Reproduit ici sous des libellés anonymisés (minimisation
 * des données / tarification dynamique), avec les mêmes tournures (« affirmer que… », « croire
 * que… ») que l'explication réfute sans qu'aucune option ne corresponde.
 * Fonctions pures, aucun appel LLM.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.CORTEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-distracteurs-absents-"));

const PRIX = [
  "Elle ajuste le prix affiché selon la demande du moment.",
  "Elle fixe un prix identique pour tous les clients en permanence.",
  "Elle réserve le tarif réduit aux membres d'un programme de fidélité.",
  "Elle applique une remise uniquement lors d'un solde annoncé.",
];

const DONNEES = [
  "Elle limite la collecte aux données strictement nécessaires à la finalité annoncée.",
  "Elle exige de recueillir le plus de données possible pour anticiper tous les usages.",
  "Elle autorise la réutilisation des données pour toute finalité ultérieure sans nouvel accord.",
  "Elle rend la conservation des données illimitée dans le temps.",
];

test("Q14 anonymisée : explication qui réfute deux affirmations absentes des 4 options, en plus des vraies", async () => {
  const { citesAbsentDistractor, repairAbsentDistractorRefs } = await import("../lib/qcm");
  const explanation = "La tarification dynamique ajuste le prix selon la demande du moment. Elle ne garde pas un prix identique en permanence, ne réserve pas le tarif aux membres fidèles et n'applique pas une remise de solde. On ne peut pas non plus affirmer qu'elle ramène le coût marginal à zéro. Dire qu'elle supprime les coûts fixes serait également faux.";
  assert.equal(citesAbsentDistractor(explanation, PRIX), true);
  const out = repairAbsentDistractorRefs(explanation, PRIX);
  assert.equal(out, "La tarification dynamique ajuste le prix selon la demande du moment. Elle ne garde pas un prix identique en permanence, ne réserve pas le tarif aux membres fidèles et n'applique pas une remise de solde.");
  assert.equal(citesAbsentDistractor(out!, PRIX), false, "plus rien à réfuter d'absent après réparation");
});

test("Q1 anonymisée : un terme absent des options (« tokenisation ») évoqué puis écarté est retiré", async () => {
  const { citesAbsentDistractor, repairAbsentDistractorRefs } = await import("../lib/qcm");
  const explanation = "Le principe de minimisation limite la collecte aux données nécessaires à la finalité annoncée. On pourrait croire qu'il s'agit d'une tokenisation des données, mais ce n'est pas le cas : aucune option ne porte sur un remplacement par un jeton.";
  assert.equal(citesAbsentDistractor(explanation, DONNEES), true);
  const out = repairAbsentDistractorRefs(explanation, DONNEES);
  assert.equal(out, "Le principe de minimisation limite la collecte aux données nécessaires à la finalité annoncée.");
});

test("une affirmation réfutée qui correspond à une VRAIE option n'est jamais un faux positif", async () => {
  const { citesAbsentDistractor } = await import("../lib/qcm");
  const explanation = "On pourrait penser qu'elle autorise la réutilisation des données pour toute finalité ultérieure sans nouvel accord, mais ce n'est pas le principe appliqué ici.";
  assert.equal(citesAbsentDistractor(explanation, DONNEES), false, "la clause réfutée reprend le contenu d'une option réelle (la 3e)");
});

test("explication sans aucune affirmation hypothétique : jamais signalée, rien à réparer", async () => {
  const { citesAbsentDistractor, repairAbsentDistractorRefs } = await import("../lib/qcm");
  const explanation = "Elle ajuste le prix affiché selon la demande du moment ; les autres options décrivent des pratiques différentes.";
  assert.equal(citesAbsentDistractor(explanation, PRIX), false);
  assert.equal(repairAbsentDistractorRefs(explanation, PRIX), null, "rien à retirer : réécriture non nécessaire");
});

test("explication entièrement bâtie sur une affirmation absente : retirer tout la viderait, repli sur le rejet habituel", async () => {
  const { repairAbsentDistractorRefs } = await import("../lib/qcm");
  const out = repairAbsentDistractorRefs("On pourrait croire qu'il s'agit d'une tokenisation des données.", DONNEES);
  assert.equal(out, null, "aucune phrase ne reste : le rejet classique reprend la main, pas une explication vide");
});
