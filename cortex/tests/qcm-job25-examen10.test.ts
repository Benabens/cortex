/**
 * JOB 25 (15/11/2026, examen QCM #10, 20 QCM tous vérifiés) — relevé sans appel au modèle, sur des
 * libellés anonymisés et paraphrasés (cf. PR #84/#90) reconstituant les mêmes tournures :
 *  - Q7/Q8/Q9/Q15/Q6 : des explications réfutaient des distracteurs ABSENTS sous une forme que
 *    #90 ne voyait pas — une énumération après « ni… ni… » ou « les autres options évoquent… »,
 *    pas « l'option qui… ». `refutedItems`/`explanationIssues` comptent désormais les segments
 *    séparés par « ni », une virgule ou « ou », et ignorent le verbe de renvoi en tête
 *    (« évoquent… »).
 *  - Q10/Q15 et Q17/Q20 : deux clés qui énoncent le même fait sous un autre libellé de notion —
 *    `keyNotion` (la tête de l'option) ne les rapprochait pas ; `suspectPairs` les soumet
 *    maintenant en priorité au contrôle des doublons via `keyProposition`/`sameProposition`
 *    (recouvrement des racines de la bonne réponse entière).
 *  - Q5 : étiquetée sous une notion du programme sans aucun rapport avec le fait réellement testé
 *    (l'étude citée porte sur la désinformation, pas sur l'économie de l'IA) — `notionMismatch` le
 *    détecte, `bestNotionMatch` recale sur le libellé du programme qui partage du vocabulaire avec
 *    le fait source.
 * Fonctions pures, aucun appel LLM.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bestNotionMatch, explanationIssues, keyProposition, notionMismatch, refutedItems, sameProposition } from "../lib/qcm-checks";

const SATIRE = {
  stem: "Pourquoi le site présenté dans l'étude de cas est-il considéré comme un vecteur de désinformation plutôt que de parodie ?",
  options: [
    "Il imite la mise en forme d'un vrai journal sans jamais signaler qu'il invente ses articles.",
    "Il publie exclusivement des articles sportifs vérifiés par une agence de presse.",
    "Il affiche un avertissement explicite indiquant qu'il s'agit d'un site parodique.",
    "Il republie des dépêches officielles sans aucune modification.",
  ],
  correct: [0],
  // Q7 : « satire assumée » n'est qu'une des trois notions réfutées, nommée avec « évoquent ».
  explanation: "Le site imite un vrai journal sans jamais le signaler, ce qui en fait un vecteur de désinformation. Les autres options évoquent une satire assumée, une couverture sportive vérifiée ou une republication fidèle.",
};

const SCRUTIN = {
  stem: "Pourquoi ce scrutin ne peut-il pas être qualifié d'élection présidentielle au sens strict ?",
  options: [
    "Parce qu'il réunit plusieurs pays dans une même circonscription.",
    "Parce que le scrutin se tient sans second tour.",
    "Parce que la participation dépasse 80 %.",
    "Parce que les candidats sont désignés par tirage au sort.",
  ],
  correct: [0],
  // Q8 : « ni… ni… ni… » sans « les autres options » ni « distracteurs ».
  explanation: "Le scrutin réunit plusieurs pays dans une même circonscription, ce qui est inhabituel. Il ne s'agit ni d'un scrutin sans second tour, ni d'une élection dans un pays unique, ni d'un tirage au sort.",
};

const SCORES = {
  stem: "Dans le scrutin à second tour décrit, pourquoi le candidat B ne peut-il pas être déclaré vainqueur ?",
  options: [
    "Parce que le second tour n'a pas encore eu lieu.",
    "Parce que les scores du premier tour ne permettent pas de conclure.",
    "Parce qu'un paradoxe de Condorcet sans vainqueur empêche toute décision.",
    "Parce que le report des voix rend le second tour impossible à organiser.",
  ],
  correct: [0],
  // Q9 : quatre réfutations pour trois distracteurs, « une absence de second tour » absente.
  explanation: "Le second tour n'a pas encore eu lieu : aucun résultat n'est disponible. Les autres options évoquent un report impossible, un paradoxe de Condorcet sans vainqueur, les scores du premier tour, et une absence de second tour.",
};

const EMPLOIS = {
  stem: "Quel phénomène explique la baisse des emplois industriels évoquée dans le texte ?",
  options: [
    "La mécanisation progressive des lignes de production.",
    "La hausse de la demande pour les produits locaux.",
    "Le départ à la retraite d'une partie de la main-d'œuvre.",
    "La fermeture temporaire des usines pour rénovation.",
  ],
  correct: [0],
  // Q6 : l'explication nomme « l'automatisation » pour le distracteur qui dit « mécanisation ».
  explanation: "La mécanisation progressive explique la baisse observée. Les autres options évoquent l'automatisation récente, la hausse de la demande ou un départ à la retraite massif.",
};

test("Q7/Q8/Q9/Q6 : énumérations après « ni » ou « évoquent » comptées, les notions absentes relevées", () => {
  for (const { label, it, absent } of [
    { label: "Q7 (satire assumée)", it: SATIRE, absent: "satire" },
    { label: "Q8 (élection dans un pays unique)", it: SCRUTIN, absent: "election" },
    { label: "Q9 (absence de second tour)", it: SCORES, absent: "absenc" },
    { label: "Q6 (automatisation vs mécanisation)", it: EMPLOIS, absent: "automat" },
  ]) {
    const issue = explanationIssues(it.explanation, it.options, it.correct, it.stem);
    assert.ok(issue, `${label} : aucun défaut relevé\n${it.explanation}`);
    assert.ok(issue!.absent.some((a) => a.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(absent)), `${label} : « ${absent} » pas dans les éléments absents (${issue!.absent.join(" | ")})`);
  }
});

test("Q15 : aucune énumération de distracteurs, l'explication reste saine", () => {
  const sain = {
    ...SATIRE,
    explanation: "Le site imite un vrai journal sans jamais le signaler, ce qui en fait un vecteur de désinformation.",
  };
  assert.equal(explanationIssues(sain.explanation, sain.options, sain.correct, sain.stem), null);
  assert.deepEqual(refutedItems(sain.explanation), []);
});

test("Q10/Q15 et Q17/Q20 : deux clés qui affirment le même fait sous d'autres mots sont rapprochées", () => {
  const Q10 = { options: ["Les leaders politiques utilisent les réseaux sociaux pour élargir leur base électorale, les processus d'influence restant fondamentalement les mêmes.", "x", "y", "z"], correct: [0] };
  const Q15 = { options: ["Les leaders utilisent les réseaux sociaux pour élargir leur base de soutien, les processus d'influence restant globalement les mêmes.", "x", "y", "z"], correct: [0] };
  const Q17 = { options: ["Le nudge rend une option plus attractive sans restreindre le choix de l'individu.", "a", "b", "c"], correct: [0] };
  const Q20 = { options: ["Un nudge rend une option plus attractive, sans jamais restreindre les choix possibles de l'individu.", "a", "b", "c"], correct: [0] };
  for (const [a, b] of [[Q10, Q15], [Q17, Q20]] as const) {
    const pa = keyProposition(a);
    const pb = keyProposition(b);
    assert.ok(pa && pb, "les deux clés ont une proposition à comparer");
    assert.ok(sameProposition(pa!, pb!), `propositions jugées différentes : « ${a.options[0]} » / « ${b.options[0]} »`);
  }
  // Deux faits réellement distincts, même thème : pas rapprochés.
  const AUTRE = { options: ["Le nudge impose une sanction financière en cas de refus de l'option recommandée.", "a", "b", "c"], correct: [0] };
  assert.equal(sameProposition(keyProposition(Q17)!, keyProposition(AUTRE)!), false);
});

test("Q5 : notion attribuée sans rapport avec le fait testé, recalée sur le libellé du programme le plus proche", () => {
  const notion = "Économie de l'IA et concentration du marché";
  const tested = "L'étude de Costello et ses collègues montre qu'un dialogue structuré avec un modèle de langage réduit l'adhésion aux théories du complot, en confrontant l'utilisateur à des faits vérifiés.";
  assert.equal(notionMismatch(notion, tested), true);
  const programme = ["Désinformation et vérification des faits", "Économie de l'IA et concentration du marché", "Souveraineté des données"];
  assert.equal(bestNotionMatch(tested, programme), "Désinformation et vérification des faits");
  // La bonne étiquette, elle, n'est jamais signalée.
  assert.equal(notionMismatch("Désinformation et vérification des faits", tested), false);
});

test("une étiquette générale (peu de mots propres) n'est jamais signalée : trop court pour juger", () => {
  assert.equal(notionMismatch("Introduction", "L'étude de Costello et ses collègues porte sur la désinformation."), false);
});
