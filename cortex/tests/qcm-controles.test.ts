/**
 * CONTRÔLES DÉTERMINISTES D'UN QCM (lib/qcm-checks) — examen QCM #9 (job 23, 14/11/2026),
 * rejoué sur ses options et explications telles que livrées (énoncés paraphrasés, noms fictifs,
 * cf. PR #84). Le contrôle de #82/#83 ne
 * reconnaissait que la tournure « affirmer que… » : il ne relevait AUCUNE des neuf explications
 * fautives. Verrouillé, sans appel au modèle :
 *  - les neuf explications qui réfutent des options absentes ou trop d'options (Q1, Q6, Q9, Q10,
 *    Q11, Q12, Q13, Q19, Q20) sont relevées, les onze autres non ;
 *  - Q9 et ses deux options « Le biais de disponibilité, soit… » ; une inversion ou un chiffre
 *    changé restent des distracteurs permis ;
 *  - la notion de la bonne réponse rapproche Q1/Q14/Q16, Q4/Q17, Q5/Q18, et les plafonds les retirent.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { capDrops, duplicateOptionIndices, explanationIssues, keyNotion, keyOnlyExplanation, notionBase, notionCap, refutedItems, ultimateAuditActions } from "../lib/qcm-checks";

type Item = { n: number; topic: string; verified: 0 | 1 | null; stem: string; options: string[]; correct: number[]; explanation: string };
const EXAM9: Item[] = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "qcm-job23-examen9.json"), "utf8")).items;
const q = (n: number) => EXAM9.find((it) => it.n === n)!;

test("examen #9 : les neuf explications qui réfutent des options absentes ou trop d'options sont relevées, les onze autres non", () => {
  const flagged = EXAM9.filter((it) => explanationIssues(it.explanation, it.options, it.correct, it.stem)).map((it) => it.n);
  assert.deepEqual(flagged, [1, 6, 9, 10, 11, 12, 13, 19, 20]);
});

test("audit ultime : retire une clé fausse et répare une question aux distracteurs triviaux", () => {
  const initial = [{ stem: "Principe alpha", trivialDistractors: null }, { stem: "Méthode bêta", trivialDistractors: null }, { stem: "Condition gamma", trivialDistractors: null }];
  const ultime = [{ ...initial[0] }, { ...initial[1], trivialDistractors: [2] }];
  assert.deepEqual(ultimateAuditActions(initial, ultime), { drop: [2], repair: [1] });
});

test("explication : le défaut relevé est le bon (compte, puis notion ou affirmation absente)", () => {
  // Q10 : cinq éléments réfutés pour trois options fausses.
  assert.deepEqual([explanationIssues(q(10).explanation, q(10).options, q(10).correct, q(10).stem)!.refuted, 3], [5, 3]);
  // Q9 : « le biais de négativité », qu'aucune des quatre options ne nomme.
  assert.match(explanationIssues(q(9).explanation, q(9).options, q(9).correct, q(9).stem)!.absent.join(" | "), /négativité/);
  // Q11 : « supposent à tort qu'ils exigent une plateforme propriétaire », absent des options.
  assert.match(explanationIssues(q(11).explanation, q(11).options, q(11).correct, q(11).stem)!.absent.join(" | "), /plateforme propriétaire/);
  // Q19 : trois éléments pour trois options fausses, mais l'un (« la plateforme numérique exclut la définition ») n'en est aucune.
  const q19 = explanationIssues(q(19).explanation, q(19).options, q(19).correct, q(19).stem)!;
  assert.equal(q19.refuted, 3);
  assert.match(q19.absent.join(" | "), /plateforme numérique exclut/);
});

test("explication : une réfutation par le défaut de l'option (« inversent l'ordre… », « soit parce qu'elles… ») n'est pas prise pour une option absente", () => {
  for (const n of [8, 15, 16]) assert.equal(explanationIssues(q(n).explanation, q(n).options, q(n).correct, q(n).stem), null, `Q${n}`);
  assert.equal(refutedItems(q(8).explanation).length, 3, "« soit parce qu'elles…, soit parce que…, soit parce que… » : trois éléments");
});

test("explication réduite à la justification de la clé quand la réécriture échoue", () => {
  assert.equal(keyOnlyExplanation(q(9).explanation), "La bonne réponse est l'excès de confiance, soit la tendance à se juger plus compétent que la moyenne même quand les données objectives ne le confirment pas, comme l'a montré Svenson (1981).");
  const q6 = keyOnlyExplanation(q(6).explanation)!;
  assert.match(q6, /^Le cours présente la motivation comme le pendant direct du leadership/);
  assert.doesNotMatch(q6, /et non|effet secondaire|devenir leader/);
  for (const it of [q(9), q(6)]) assert.equal(explanationIssues(keyOnlyExplanation(it.explanation)!, it.options, it.correct, it.stem), null);
});

test("Q9 : deux options fausses sur la même notion sont relevées ; inversion, chiffre changé et bonne notion avec une mauvaise raison restent permis", () => {
  assert.deepEqual(EXAM9.filter((it) => duplicateOptionIndices(it.options, it.correct).length).map((it) => [it.n, duplicateOptionIndices(it.options, it.correct)]), [[9, [3]]]);
  const vosoughi = [
    "Les fausses nouvelles se diffusent environ six fois plus vite que les vraies.",
    "Les vraies nouvelles se diffusent environ six fois plus vite que les fausses.",
    "Les fausses nouvelles se diffusent environ dix fois plus vite que les vraies.",
    "Les deux types de nouvelles se diffusent à la même vitesse sur Twitter.",
  ];
  assert.deepEqual(duplicateOptionIndices(vosoughi, [0]), []);
  const rightNameWrongReason = [
    "Le biais de disponibilité, soit des souvenirs marquants qui remplacent la statistique.",
    "Le biais de disponibilité, car la personne manque d'informations sur le risque.",
    "Le biais de négativité, soit l'attention portée d'abord aux menaces.",
    "L'effet d'amorçage, soit l'activation inconsciente d'associations.",
  ];
  assert.deepEqual(duplicateOptionIndices(rightNameWrongReason, [0]), []);
  assert.deepEqual(duplicateOptionIndices(["Une option.", "Une autre option.", "une option", "Encore une."], [1]), [2], "même libellé : la seconde");
});

test("notion de la bonne réponse : Q1/Q14/Q16, Q4/Q17 et Q5/Q18 ont chacune la même", () => {
  const keys = new Map<string, number[]>();
  for (const it of EXAM9) {
    const k = keyNotion(it);
    if (k) keys.set(k, [...(keys.get(k) ?? []), it.n]);
  }
  assert.deepEqual(keys.get("biais de disponibilite"), [1, 14, 16]);
  assert.deepEqual(keys.get("realite partagee"), [4, 17]);
  assert.deepEqual(keys.get("confiance"), [5, 18]);
});

test("plafonds : dix notions pour vingt questions = deux par notion ; une seule question par notion de bonne réponse", () => {
  assert.equal(notionCap(10, 20), 2);
  assert.equal(notionCap(30, 20), 1);
  assert.equal(notionCap(3, 20), 7, "programme trop court : le nombre demandé reste atteignable");
  assert.equal(notionBase("Désinformation : notions clés — réalité partagée"), notionBase("Désinformation : notions clés"));
  // Par notion de bonne réponse seule (contrôle du modèle en échec, aucun libellé de notion) :
  // Q14, Q16 (biais de disponibilité), Q17 (réalité partagée), Q18 (confiance).
  const byKey = capDrops(EXAM9, { perNotion: 2, perKey: 1 }, () => []).map((i) => EXAM9[i].n);
  assert.deepEqual(byKey, [14, 16, 17, 18]);
  // Avec la notion du programme : Q7 en plus, troisième question sur « Désinformation ».
  const both = capDrops(EXAM9, { perNotion: 2, perKey: 1 }, (it) => [it.topic]).map((i) => EXAM9[i].n);
  assert.deepEqual(both, [7, 14, 16, 17, 18]);
  // Une question de l'accent demandé par l'étudiant ne compte pas.
  const focus = EXAM9.map((it) => ({ ...it, focusSlot: it.n === 14 }));
  assert.deepEqual(capDrops(focus, { perNotion: 2, perKey: 1 }, () => []).map((i) => focus[i].n), [16, 17, 18]);
});

test("plafonds : deux libellés d'une même question ne rapprochent pas les autres questions de l'un et de l'autre", () => {
  const it = (notion: string, llm: string) => ({ notion, llm, options: ["a", "b", "c", "d"], correct: [0] });
  // Q2 (sujet B, biais) et Q6 (sujet B, souveraineté) tiennent le sujet B ; une troisième question « biais » reste permise.
  const items = [it("A", "nudge"), it("B", "biais"), it("C", "souveraineté"), it("D", "nudge"), it("B", "souveraineté"), it("E", "biais")];
  assert.deepEqual(capDrops(items, { perNotion: 2, perKey: 1 }, (x) => [x.notion, x.llm]), []);
  assert.deepEqual(capDrops([...items, it("F", "biais")], { perNotion: 2, perKey: 1 }, (x) => [x.notion, x.llm]), [6]);
});
