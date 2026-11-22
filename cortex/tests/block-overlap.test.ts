/**
 * NON-RECOUVREMENT des questions composées (lib/block-overlap), sans appel au modèle.
 * Prod, 22/11/2026 (cours fictif d'œnologie) : la Q1 portait sur l'assemblage de deux vins et la
 * Q2(c) refaisait un assemblage ; la Q2(b) traitait la fermentation bloquée, la Q3 entière aussi.
 * Exemples INVENTÉS ci-dessous, sur le même schéma.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { findOverlaps, type OverlapBlock } from "../lib/block-overlap";

const part = (prompt: string, options: string[] = []) => ({ prompt, options, answer: "" });

const blending: OverlapBlock = {
  title: "Blending two wines",
  scenario: "A winemaker has a tank of Merlot (13.5 % alcohol) and a tank of Cabernet (12.5 % alcohol).",
  parts: [
    part("Which proportion of the blend gives 13 % alcohol?", ["50/50", "40/60", "60/40", "30/70"]),
    part("Why blend two varieties rather than bottle them separately?"),
    part("Name one sensory risk of the blend."),
  ],
};
const cellar: OverlapBlock = {
  title: "Managing the cellar after harvest",
  scenario: "After harvest, the cellar master monitors several tanks; one of them stopped bubbling at 8 g/L of residual sugar.",
  parts: [
    part("What temperature range suits the cellar during alcoholic fermentation?", ["10-12 °C", "18-25 °C", "30-35 °C", "40-45 °C"]),
    part("The tank stopped at 8 g/L of sugar: explain why its fermentation got stuck."),
    part("The cellar master wants to blend this tank with another wine: what blend proportion keeps the alcohol under 13 %?"),
    part("Which hygiene rule prevents spoilage in the cellar?"),
  ],
};
const stuck: OverlapBlock = {
  title: "Restarting a stuck fermentation",
  scenario: "A white wine fermentation stopped with 15 g/L of residual sugar left.",
  parts: [
    part("Give two causes of a stuck fermentation."),
    part("Which yeast addition restarts the fermentation?", ["A pied de cuve", "Sulfur dioxide", "Bentonite", "Tartaric acid"]),
    part("Why must the restart be done quickly?"),
  ],
};
const tasting: OverlapBlock = {
  title: "Tasting and describing a red wine",
  scenario: "A taster describes the colour, nose and palate of a young red wine.",
  parts: [
    part("Which term describes a purple rim?", ["Evolved", "Youthful", "Oxidised", "Brick"]),
    part("What does a long finish indicate?"),
    part("Which descriptor belongs to the primary aromas?"),
  ],
};

test("prod 22/11 : Q2(b) reprend la Q3 entière, Q2(c) reprend la Q1 → ces deux sous-questions sont signalées", () => {
  const found = findOverlaps([blending, cellar, stuck, tasting]);
  assert.deepEqual(found.map(({ block, part, other }) => ({ block, part, other })), [
    { block: 1, part: 1, other: 2 },
    { block: 1, part: 2, other: 0 },
  ]);
});

test("des questions sur des sujets distincts ne sont pas signalées, même avec le vocabulaire commun du cours (wine, tank…)", () => {
  assert.deepEqual(findOverlaps([blending, stuck, tasting]), []);
});

test("deux questions entières sur le même sujet : la plus tardive est signalée en entier (part = -1)", () => {
  const again: OverlapBlock = { ...stuck, title: "A stuck fermentation in a red wine", scenario: "A red wine fermentation got stuck at 6 g/L of sugar." };
  assert.deepEqual(findOverlaps([blending, stuck, tasting, again]).map(({ block, part, other }) => ({ block, part, other })), [{ block: 3, part: -1, other: 1 }]);
  // Un mot de titre en commun ne suffit pas : « Blending » et « Blending for colour » restent deux sujets.
  const colour: OverlapBlock = { ...tasting, title: "Blending for colour stability" };
  assert.ok(!findOverlaps([blending, stuck, colour]).some((o) => o.part === -1));
});

test("en français aussi : « deux vins » ne nomme pas un sujet, « assemblage » si", () => {
  const fr = (title: string, scenario: string, prompts: string[]): OverlapBlock => ({ title, scenario, parts: prompts.map((p) => part(p)) });
  const found = findOverlaps([
    fr("Assemblage de deux vins", "Un vigneron dispose d'une cuve de merlot et d'une cuve de cabernet.", ["Quelle proportion de l'assemblage donne 13 % ?", "Pourquoi assembler deux cépages ?", "Citez un risque gustatif de l'assemblage."]),
    fr("Le chai après les vendanges", "Le maître de chai surveille ses cuves après les vendanges.", ["Quelle température convient au chai pendant la fermentation alcoolique ?", "Il veut assembler cette cuve avec un autre vin : quelle proportion de l'assemblage choisir ?", "Quelle règle d'hygiène protège le chai ?"]),
    fr("Dégustation d'un vin rouge", "Un dégustateur décrit la robe, le nez et la bouche d'un vin rouge jeune.", ["Quel terme décrit un disque violacé ?", "Que signifie une longue finale ?", "Quel descripteur relève des arômes primaires ?"]),
  ]);
  assert.deepEqual(found.map(({ block, part, other }) => ({ block, part, other })), [{ block: 1, part: 1, other: 0 }]);
});
