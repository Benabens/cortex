/**
 * FINITIONS QCM v7 — examen QCM #16 d'un cours de sciences humaines (16/11/2026, job 31) : 20/20,
 * clé juste partout, mais encore :
 *  1. deux questions sur le même fait (la définition d'une incitation douce appliquée deux fois à
 *     une cantine), bâties sur deux faits distincts qui disaient la même chose : le contrôle par
 *     identifiant de fait ne les voyait pas ;
 *  2. une question étiquetée sous une autre notion que celle qu'elle teste (le rejeu de bout en
 *     bout est dans tests/qcm-faits-rejeu.test.ts) ;
 *  3. le corrigé PDF : « Duration: 0 minutes », et des notes « idée fausse » coupées en fragments.
 * Les énoncés ci-dessous sont des paraphrases inventées, pas le contenu d'un cours.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { closeFacts, definedTerm, factDuplicates, factId, planFacts, type CourseFact } from "../lib/qcm-facts";
import { commonStemRoots, sameNotionQuestion } from "../lib/qcm-checks";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-v7-"));
process.env.CORTEX_DATA_DIR = tmp;

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const NOTION = "Incitations douces et architecture du choix";
const q = (stem: string, key: string, notion = NOTION, others = ["Une autre affirmation.", "Encore une autre.", "Une dernière."]) =>
  ({ stem, notion, options: [key, ...others], correct: [0] });

/** La paire de l'examen #16, paraphrasée : même notion, même décor (une cantine), même définition. */
const CANTINE_1 = q(
  "Un restaurant universitaire veut réduire la consommation de sodas. Une gérante propose de supprimer les sodas des vitrines ; un gérant propose de les ranger en bas des vitrines, moins visibles, en laissant toutes les boissons en vente. Selon la définition donnée dans le cours, laquelle des affirmations suivantes est correcte ?",
  "Le gérant applique une incitation douce : il garde toutes les boissons en vente et rend l'eau plus visible.",
);
const CANTINE_2 = q(
  "Un restaurant scolaire veut augmenter la consommation de fruits par les élèves. Selon la définition donnée dans le cours, laquelle des mesures suivantes est une incitation douce au sens strict ?",
  "Poser les fruits en tête du comptoir, à hauteur des yeux, en laissant les élèves libres de prendre autre chose.",
);

test("examen #16 : même notion, même décor de cantine → la seconde question reteste le même fait", () => {
  assert.ok(sameNotionQuestion(CANTINE_1, CANTINE_2));
  assert.deepEqual(factDuplicates([{ ...CANTINE_1, factId: "f-a" }, { ...CANTINE_2, factId: "f-b" }]), [1], "deux faits distincts, une seule question gardée");
});

test("même notion sous deux angles vraiment distincts : les deux questions restent", () => {
  const alignement = "Alignement des modèles de langage";
  const pairs = [
    // le rôle des humains / l'origine des étiquettes (une même notion, deux faits)
    [q("Dans l'approche par principes écrits présentée dans le cours, quel rôle revient aux humains face au second modèle ?", "Les humains rédigent les principes ; un second modèle produit les préférences servant à l'ajustement.", alignement),
      q("Concernant l'origine des étiquettes d'entraînement, laquelle des descriptions suivantes distingue les deux méthodes ?", "La seconde méthode remplace toutes les étiquettes humaines par des étiquettes produites par une machine.", alignement)],
    // la définition / l'efficacité dans la durée
    [q("Selon la définition exposée dans le cours, laquelle des situations suivantes est un exercice de conduite d'équipe ?", "Une fondatrice rallie des bénévoles autour d'un projet commun et coordonne leurs actions.", "Conduite d'équipe"),
      q("Deux dirigeants d'ateliers concurrents : l'un fixe un cap et laisse l'autonomie, l'autre impose chaque étape contre des primes. Lequel est le plus efficace dans la durée ?", "Celui qui fixe un cap et laisse l'autonomie, car tous les styles ne se valent pas dans la durée.", "Conduite d'équipe")],
  ];
  for (const [a, b] of pairs) {
    assert.ok(!sameNotionQuestion(a, b), `${a.stem.slice(0, 50)} / ${b.stem.slice(0, 50)}`);
    assert.deepEqual(factDuplicates([{ ...a, factId: "f-a" }, { ...b, factId: "f-b" }]), []);
  }
  // Deux notions différentes : jamais rapprochées par ce contrôle, même sur un décor voisin.
  assert.ok(!sameNotionQuestion(CANTINE_1, { ...CANTINE_2, notion: "Biais de présentation" }));
});

test("même bonne réponse reformulée dans une même notion : un doublon, même sans décor commun", () => {
  const a = q("Que dit le cours du rôle des humains dans l'approche par principes écrits ?", "Les humains rédigent une liste de principes généraux qui guide tout l'entraînement du modèle.");
  const b = q("Dans la méthode dite constitutionnelle, qui fixe le cadre ?", "Une liste de principes généraux rédigée par des humains guide tout l'entraînement du modèle.");
  assert.ok(sameNotionQuestion(a, b));
});

test("tournure maison d'un examen : les mots présents dans un quart des énoncés ne font pas un décor commun", () => {
  const frame = (k: number, body: string) => `Question ${k} de révision rapide sur le chapitre : ${body} ?`;
  const stems = [
    frame(1, "pourquoi la cantine range-t-elle les fruits devant"), frame(2, "que montre l'étude du vote par paires"),
    frame(3, "que garantit la méthode du gagnant des duels"), frame(4, "pourquoi un deuxième atelier distribue-t-il des primes"),
  ];
  const common = commonStemRoots(stems);
  for (const w of ["quest", "revis", "rapid", "chapi"]) assert.ok(common.has(w), w);
  const a = q(stems[1], "Le vote par paires désigne le gagnant de tous les duels.");
  const b = q(stems[2], "La méthode garantit la victoire du gagnant de chaque duel.");
  // Sans le filtre, « question », « révision », « rapide », « chapitre » suffiraient à faire un décor commun.
  assert.ok(sameNotionQuestion(a, b, new Set()), "sans filtre : faux décor commun");
  assert.ok(!sameNotionQuestion(a, b, common), "avec le filtre : deux questions distinctes");
});

test("deux questions de l'accent demandé ne se comparent pas entre elles ; sans faits, le contrôle du modèle décide", () => {
  const a = { ...CANTINE_1, factId: "f-a" };
  const b = { ...CANTINE_2, factId: "f-b" };
  assert.deepEqual(factDuplicates([{ ...a, focusSlot: true }, { ...b, focusSlot: true }]), []);
  assert.deepEqual(factDuplicates([{ ...a, focusSlot: true }, b]), [1]);
  assert.deepEqual(factDuplicates([CANTINE_1, CANTINE_2]), [], "conception par notion : inchangée");
});

const fact = (notion: string, statement: string, passage: string): CourseFact => ({ id: factId(statement), notion, statement, passage });

test("plan : deux faits qui définissent le même terme ne sont pas posés dans le même examen", () => {
  assert.deepEqual([...definedTerm("Une incitation douce est une modification de la présentation des choix.") ?? []], ["incit", "douce"]);
  assert.equal(definedTerm("Le vote par paires élit le gagnant des duels."), null, "pas une définition");
  const a = fact(NOTION, "Une incitation douce est une modification de la présentation des choix qui n'en retire aucun.", "Le cours définit l'incitation douce par la présentation.");
  const b = fact(NOTION, "L'incitation douce désigne tout réaménagement de l'offre qui laisse chaque option disponible.", "Exemple de la cantine : les fruits en tête du comptoir.");
  const c = fact(NOTION, "Interdire un produit relève de la contrainte, pas de l'architecture du choix.", "Une interdiction retire une option du menu.");
  const other = (k: number) => fact(`Notion ${k}`, `Le terme${k}a a le terme${k}b si le terme${k}c est au terme${k}d.`, `Le terme${k}a et le terme${k}b.`);
  assert.ok(closeFacts(a, b));
  assert.ok(!closeFacts(a, c), "un fait voisin mais distinct");
  assert.ok(!closeFacts(a, { ...b, notion: "Autre notion" }), "seulement dans une même notion");
  const { picked, reserve } = planFacts([a, b, c, other(1), other(2)], { order: [NOTION, "Notion 1", "Notion 2"], count: 4, cap: 2 });
  assert.deepEqual(picked.map((f) => f.id), [a.id, other(1).id, other(2).id, c.id], "la notion garde deux questions, sur deux faits distincts");
  assert.deepEqual(reserve.map((f) => f.id), [b.id], "le fait trop proche reste en réserve, en dernier");
});

test("durée de l'examen : un profil sans durée (0) ne s'affiche plus « 0 minutes »", async () => {
  const { runWithCourse } = await import("../db/client");
  const { qcmDurationMin } = await import("../lib/qcm-latex");
  assert.equal(await qcmDurationMin(120), 120);
  assert.equal(await runWithCourse("ml", () => qcmDurationMin(0)), null, "inconnue : pas de durée inventée");
  assert.equal(await runWithCourse("ml", () => qcmDurationMin(null)), null);
});

/** Texte d'un PDF, sans césure de fin de ligne, ligature ni apostrophe typographique, espaces ramenés à un seul. */
function pdfText(file: string): string {
  return execFileSync("pdftotext", ["-raw", file, "-"], { encoding: "utf8" })
    .normalize("NFKC").replace(/[‘’]/g, "'").replace(/-\n/g, "").replace(/\s+/g, " ");
}

test("corrigé PDF : notes « idée fausse » entières sous chaque option, aucune durée à 0", async (t) => {
  const { texAvailable } = await import("../lib/exam-latex");
  if (!texAvailable()) return t.skip("tectonic/pdflatex absent");
  try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); } catch { return t.skip("pdftotext absent"); }
  const { runWithCourse } = await import("../db/client");
  const { buildQcmArtifact } = await import("../lib/qcm-latex");
  const { examsDir } = await import("../lib/paths");
  const misconceptions = [
    "",
    "[inversion] croire que retirer une option reste une incitation douce, alors que le cours exige de laisser chaque option disponible pour tout le monde",
    "[confusion] assimiler une taxe à une incitation douce, alors qu'une taxe change le prix relatif et donc les incitations économiques des clients",
    "[sur-généralisation] penser que tout affichage oriente le choix au cœur de la décision",
  ];
  const item = {
    topic: NOTION, type: "scq" as const,
    stem: "Une cafétéria veut réduire la consommation de sodas. Laquelle des mesures suivantes est une incitation douce au sens du cours ?",
    options: [
      "Ranger les sodas en bas des vitrines, moins visibles, en laissant toutes les boissons en vente.",
      "Retirer les sodas de la vente.",
      "Taxer les sodas, une mesure qui touche directement au prix relatif de toutes les boissons proposées à la cafétéria chaque jour.",
      "Afficher le prix.",
    ],
    correct: [0], misconceptions, explanation: "Seule la première garde toutes les options.", verified: 1 as const,
  };
  const out = await runWithCourse("ml", () => buildQcmArtifact(7171, { items: [item], open: [] }, "2026-11-16"));
  assert.equal(out.texError, undefined, out.texError);
  const dir = runWithCourse("ml", () => examsDir());
  const tex = fs.readFileSync(path.join(dir, "qcm-7171-corrige.tex"), "utf8");
  assert.doesNotMatch(tex, /\\hfill\{\\footnotesize\\itshape/, "plus de note poussée à droite de l'option");
  const text = pdfText(path.join(dir, "qcm-7171-corrige.pdf"));
  for (const m of misconceptions.filter(Boolean)) assert.ok(text.includes(`idée fausse : ${m}`), `note entière, d'un seul tenant : ${m}\n---\n${text}`);
  // Chaque note suit son option, jamais l'inverse ni un mélange de deux options.
  assert.ok(text.indexOf("Retirer les sodas de la vente.") < text.indexOf("idée fausse : [inversion]"));
  assert.ok(text.indexOf("idée fausse : [inversion]") < text.indexOf("C. Taxer les sodas"));
  assert.doesNotMatch(text, /\b0 minutes\b/);
  assert.doesNotMatch(pdfText(path.join(dir, "qcm-7171.pdf")), /idée fausse/i, "l'énoncé ne montre aucune note");
});
