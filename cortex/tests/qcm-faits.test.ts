/**
 * FAITS TESTABLES (lib/qcm-facts) — examen QCM #14 d'un cours de sciences humaines (15/11/2026) :
 * 20 questions, une quinzaine de notions, et encore deux ou trois paires qui testaient la même
 * règle sous deux scénarios. Verrouillé ici, sans modèle :
 *  - deux faits qui disent la même chose (reformulés, ou sur le même passage) fusionnent ;
 *  - la répartition donne un fait distinct par question, le maximum de notions d'abord, au plus
 *    `cap` par notion, les faits jamais posés avant les autres ;
 *  - deux questions sur un même fait : la seconde est un doublon, par identifiant ;
 *  - une question bâtie sur le passage d'un autre fait lui est rattachée ;
 *  - la sélection ne retient jamais deux questions d'un même fait.
 * Les énoncés ci-dessous sont des paraphrases inventées, pas le contenu d'un cours.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { attributedFact, factDuplicates, factId, factsPerNotion, mergeFacts, planFacts, sameFact, type CourseFact } from "../lib/qcm-facts";
import { selectWithinTrivialBudget } from "../lib/qcm";

const fact = (notion: string, statement: string, passage: string): CourseFact => ({ id: factId(statement), notion, statement, passage });

/** Les trois paires de l'examen #14, paraphrasées : chaque fois la même proposition, deux formulations. */
const PAIRS: [CourseFact, CourseFact][] = [
  [
    fact("Leadership", "La motivation des équipes est le pendant direct du leadership.", "Le cours présente la motivation des équipes comme le pendant direct du leadership."),
    fact("Conduite du changement", "Le leadership a pour pendant direct la motivation des équipes.", "Rappel : le leadership a pour pendant direct la motivation des équipes."),
  ],
  [
    fact("Souveraineté numérique", "Des données hébergées en Suisse restent soumises à une loi étrangère extraterritoriale, ce qui compromet la souveraineté.", "Un hébergement en Suisse ne protège pas des lois étrangères extraterritoriales : la souveraineté des données reste compromise."),
    fact("Informatique en nuage", "Même stockées en Suisse, des données exposées à une loi étrangère à portée extraterritoriale voient leur souveraineté compromise.", "Le stockage en Suisse ne suffit pas : une loi étrangère extraterritoriale compromet la souveraineté des données."),
  ],
  [
    fact("Architecture du choix", "Un nudge modifie l'option par défaut sans supprimer le choix.", "Le nudge modifie l'option par défaut sans jamais supprimer le choix de la personne."),
    fact("Biais cognitifs", "Changer l'option par défaut tout en laissant le choix ouvert est un nudge.", "Le nudge modifie l'option par défaut sans jamais supprimer le choix de la personne."),
  ],
];

test("identifiant d'un fait : stable à la casse, aux accents et à la ponctuation près", () => {
  assert.equal(factId("Un nudge modifie l'option par défaut."), factId("un NUDGE modifie l option par defaut"));
  assert.notEqual(factId("Un nudge modifie l'option par défaut."), factId("Un nudge supprime l'option par défaut."));
});

test("examen #14 : chacune des trois paires est un seul fait, même sous deux notions", () => {
  for (const [a, b] of PAIRS) {
    assert.ok(sameFact(a, b), `même proposition : « ${a.statement} » / « ${b.statement} »`);
    assert.equal(mergeFacts([a, b]).length, 1);
  }
  const merged = mergeFacts(PAIRS.flat());
  assert.deepEqual(merged.map((f) => f.notion), ["Leadership", "Souveraineté numérique", "Architecture du choix"], "le premier de chaque paire reste");
});

test("deux faits voisins d'une même notion restent distincts", () => {
  const facts = [
    fact("Biais cognitifs", "Le biais de négativité donne plus de poids aux informations négatives qu'aux positives.", "Les informations négatives pèsent davantage que les positives."),
    fact("Biais cognitifs", "Le biais de disponibilité fait surestimer les événements récents ou marquants.", "Un événement récent et marquant paraît plus probable qu'il ne l'est."),
    fact("Architecture du choix", "Un nudge modifie l'option par défaut sans supprimer le choix.", "Le nudge modifie l'option par défaut sans jamais supprimer le choix de la personne."),
    fact("Architecture du choix", "Une interdiction n'est pas un nudge, puisqu'elle retire une option.", "Interdire une option revient à la retirer : ce n'est plus une incitation douce."),
  ];
  assert.equal(mergeFacts(facts).length, 4);
});

/** Cours fictif : `notions` notions, `per` faits chacune, énoncés sans aucun mot commun. */
function courseFacts(notions: number, per: number): CourseFact[] {
  const out: CourseFact[] = [];
  for (let i = 0; i < notions; i++) for (let j = 0; j < per; j++) {
    const w = (k: number) => `mot${String.fromCharCode(97 + i)}${String.fromCharCode(97 + j)}${String.fromCharCode(97 + k)}x`;
    out.push(fact(`Notion ${i + 1}`, `Le ${w(0)} a le ${w(1)} si le ${w(2)} est au ${w(3)}.`, `Le ${w(0)} et le ${w(1)}, ${w(2)} et ${w(3)}.`));
  }
  return out;
}

test("répartition : 20 questions sur 15 notions → 20 faits distincts, 15 notions, au plus 2 par notion", () => {
  const facts = courseFacts(15, 4);
  const order = facts.map((f) => f.notion);
  const { picked, reserve } = planFacts(facts, { order, count: 20, cap: 2 });
  assert.equal(picked.length, 20);
  assert.equal(new Set(picked.map((f) => f.id)).size, 20, "aucun fait partagé");
  const perNotion = new Map<string, number>();
  for (const f of picked) perNotion.set(f.notion, (perNotion.get(f.notion) ?? 0) + 1);
  assert.equal(perNotion.size, 15, "toutes les notions");
  assert.ok([...perNotion.values()].every((n) => n <= 2), "au plus 2 par notion");
  assert.equal(reserve.length, 40);
  assert.ok(reserve.every((f) => !picked.includes(f)), "la réserve ne redonne aucun fait de l'examen");
  // La réserve suit le même tour : d'abord les notions qui n'ont qu'une question.
  assert.ok(picked.filter((f) => f.notion === reserve[0].notion).length === 1, `réserve : ${reserve[0].notion}`);
});

test("répartition : un fait jamais posé passe avant un fait déjà posé, dans la notion comme entre notions", () => {
  const facts = courseFacts(3, 3);
  const asked = new Map([[facts[0].id, 4], [facts[1].id, 2]]); // Notion 1 : ses deux premiers faits déjà posés
  const { picked } = planFacts(facts, { order: ["Notion 1", "Notion 2", "Notion 3"], count: 3, cap: 1, asked });
  assert.deepEqual(picked.map((f) => f.id), [facts[2].id, facts[3].id, facts[6].id], "Notion 1 donne son fait neuf");
  const all = planFacts(facts, { order: ["Notion 1"], count: 9, cap: 3, asked });
  const n1 = all.picked.filter((f) => f.notion === "Notion 1").map((f) => f.id);
  assert.deepEqual(n1, [facts[2].id, facts[1].id, facts[0].id], "le plus anciennement posé avant le plus récent");
  // Une notion dont tous les faits ont déjà été posés passe après les notions qui ont un fait neuf.
  const saturated = new Map([[facts[0].id, 1], [facts[1].id, 1], [facts[2].id, 1]]);
  const late = planFacts(facts, { order: ["Notion 1", "Notion 2", "Notion 3"], count: 3, cap: 1, asked: saturated });
  assert.deepEqual(late.picked.map((f) => f.notion), ["Notion 2", "Notion 3", "Notion 1"]);
});

test("répartition : moins de faits que de questions → la répartition le dit (l'examen se conçoit par notion)", () => {
  const { picked } = planFacts(courseFacts(4, 2), { order: [], count: 20, cap: 5 });
  assert.equal(picked.length, 8);
});

test("doublon par identifiant : la seconde question d'un même fait part, la première reste", () => {
  assert.deepEqual(factDuplicates([{ factId: "f-a" }, { factId: "f-b" }, { factId: "f-a" }, { factId: null }, {}, { factId: "f-b" }]), [2, 5]);
});

test("une question bâtie sur le passage d'un autre fait est rattachée à ce fait", () => {
  const [a, b] = PAIRS.map((p) => p[0]);
  // Le concepteur devait tester `b` (souveraineté) mais cite le passage de `a` (leadership).
  assert.equal(attributedFact(a.passage, b, [a, b])?.id, a.id);
  assert.equal(attributedFact(b.passage, b, [a, b])?.id, b.id, "sa propre preuve : il garde son fait");
  assert.equal(attributedFact("Une phrase sans rapport avec ces faits du cours.", b, [a, b])?.id, b.id);
  assert.equal(attributedFact(null, b, [a, b])?.id, b.id);
});

test("sélection : jamais deux questions d'un même fait, même si la seconde est meilleure", () => {
  const q = (stem: string, factId: string | null, discrimination: number) => ({ stem, factId, discrimination, options: ["a", "b", "c", "d"], correct: [0], trivialDistractors: [] as number[], topic: stem });
  const current = [q("Q1", "f-a", 2)];
  const out = selectWithinTrivialBudget(current, [q("Q2", "f-a", 5), q("Q3", "f-b", 3), q("Q4", null, 1), q("Q5", null, 1)], 4);
  assert.deepEqual(out.map((x) => x.stem), ["Q1", "Q3", "Q4", "Q5"]);
});

test("faits demandés par notion : de quoi tenir deux examens, entre 2 et 5", () => {
  assert.equal(factsPerNotion(15, 20), 4);
  assert.equal(factsPerNotion(10, 20), 5);
  assert.equal(factsPerNotion(40, 20), 2);
  assert.equal(factsPerNotion(4, 8), 5);
});
