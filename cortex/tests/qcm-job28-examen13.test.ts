/**
 * JOB 28 (15/11/2026, examen QCM #13, 20/20 tous vérifiés) — trois explications réfutaient un
 * distracteur ABSENT des options réelles sous des formes que le contrôle (#90/#97) ne voyait pas,
 * sur des libellés anonymisés et paraphrasés reconstituant les mêmes tournures :
 *  - Q1 : « contrairement aux hommes politiques, qui… » — aucune amorce de `GROUP_ANCHORS` ne
 *    reconnaissait « contrairement à/au/aux » ; `refutedItems` n'extrayait même pas l'élément.
 *  - Q3 : « ni de l'accountability…, ni de la provenance…, ni de l'éducation aux médias (media
 *    literacy) » — le troisième élément commence par une élision suivie d'une voyelle accentuée
 *    (« l'éducation ») ; `\b` est toujours ASCII en JavaScript et ne voit pas de frontière entre
 *    l'apostrophe et un « é », donc `NAMES_SOMETHING` ne reconnaissait pas l'élément. Une fois
 *    reconnu, un second bug (le seuil d'absence pour un élément court se contentait d'UN mot commun,
 *    même par coïncidence — « médias » apparaît aussi dans un distracteur sur les médias
 *    synthétiques, sans rapport) l'aurait quand même laissé passer.
 *  - Q9 : « et non à cause de la revente des données d'écoute, qui… » — l'amorce `et non ` ne
 *    consomme que ça : la cause (« à cause de ») restait en tête de l'élément, sans déterminant
 *    reconnaissable.
 * Fonctions pures, aucun appel LLM.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { explanationIssues, refutedItems, sameSourceFact } from "../lib/qcm-checks";
import { suspectPairs } from "../lib/qcm";

const CHERCHEURS = {
  stem: "Pourquoi cet article cite-t-il principalement des chercheurs universitaires ?",
  options: [
    "Parce que les chercheurs ont mené l'étude citée.",
    "Parce que les journalistes locaux ont refusé de commenter.",
    "Parce que les associations de consommateurs ont boycotté le sujet.",
    "Parce que les entreprises technologiques ont financé l'étude.",
  ],
  correct: [0],
  // Q1 : « contrairement à » introduit une seule notion absente, pas une liste.
  explanation:
    "Les chercheurs universitaires ont mené l'étude citée dans l'article, contrairement aux hommes politiques, qui ne sont jamais mentionnés comme source.",
};

const JUGEMENT = {
  stem: "Quel mécanisme explique la réduction des erreurs de jugement observée ?",
  options: [
    "Une confrontation répétée à des contre-exemples vérifiés augmente la confiance dans le raisonnement correct.",
    "Une réduction des erreurs de jugement liée à l'exposition à des médias synthétiques.",
    "Une perte de confiance générale envers les institutions.",
    "Une diminution de la fiabilité perçue des médias traditionnels.",
  ],
  correct: [0],
  // Q3 : trois notions réfutées par « ni…, ni…, ni… », aucune des trois dans les options réelles ;
  // la troisième commence par une élision devant voyelle accentuée (« l'éducation »).
  explanation:
    "La confrontation répétée à des contre-exemples vérifiés augmente la confiance dans le raisonnement correct. Elle ne relève ni de l'accountability des plateformes, ni de la provenance du contenu, ni de l'éducation aux médias (media literacy).",
};

const PODCAST = {
  stem: "Pourquoi l'utilisateur a-t-il résilié son abonnement au service de podcast ?",
  options: [
    "Parce que l'application affichait trop de publicités non pertinentes.",
    "Parce que le catalogue ne proposait plus les émissions suivies.",
    "Parce que le prix de l'abonnement a doublé en un an.",
    "Parce que l'application plantait fréquemment au lancement.",
  ],
  correct: [0],
  // Q9 : « et non à cause de… » — la cause elle-même reste en tête de l'élément après l'amorce.
  explanation:
    "L'utilisateur a résilié à cause des publicités non pertinentes affichées en boucle, et non à cause de la revente des données d'écoute, qui n'est jamais évoquée dans le témoignage.",
};

test("Q1/Q3/Q9 : trois tournures jusqu'ici invisibles, la notion absente est relevée", () => {
  for (const { label, it, absent } of [
    { label: "Q1 (contrairement à)", it: CHERCHEURS, absent: "homme" },
    { label: "Q3 (ni… ni… ni…, élision devant voyelle accentuée)", it: JUGEMENT, absent: "ducat" },
    { label: "Q9 (et non à cause de)", it: PODCAST, absent: "revent" },
  ]) {
    const issue = explanationIssues(it.explanation, it.options, it.correct, it.stem);
    assert.ok(issue, `${label} : aucun défaut relevé\n${it.explanation}`);
    assert.ok(
      issue!.absent.some((a) => a.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(absent)),
      `${label} : « ${absent} » pas dans les éléments absents (${issue!.absent.join(" | ")})`,
    );
  }
});

test("Q3 : les trois notions réfutées sont TOUTES absentes, aucune n'est exemptée par un mot partagé par hasard", () => {
  const issue = explanationIssues(JUGEMENT.explanation, JUGEMENT.options, JUGEMENT.correct, JUGEMENT.stem)!;
  assert.equal(issue.refuted, 3);
  assert.equal(issue.absent.length, 3, `« éducation aux médias » ne doit pas être exemptée par le « médias » du distracteur sur les médias synthétiques (${issue.absent.join(" | ")})`);
});

test("un élément court dont la tête est réellement reprise par une option n'est jamais pris pour une notion absente", () => {
  // « les biais cognitifs » désigne bien l'option « Les biais, soit… » : même tête (« biais »),
  // seul le qualificatif (« cognitifs ») n'a pas d'appui, ce qui reste permis (cf. examen #9, Q17/Q18).
  const stem = "Dans ce scénario, pourquoi l'accord sur les faits bruts se dégrade-t-il ?";
  const options = [
    "La réalité partagée, soit une base factuelle commune qui se fragmente ici entre communautés.",
    "Les biais, soit les erreurs systématiques de jugement qui conduisent chaque communauté à retenir des faits différents.",
    "La confiance envers les institutions, qui reste intacte dans ce scénario.",
    "L'éducation aux médias, qui ne garantit pas en soi un socle factuel commun.",
  ];
  const explanation =
    "La bonne réponse est la réalité partagée, qui se fragmente ici entre communautés. Les distracteurs confondent ce concept avec les biais cognitifs, avec la confiance envers les institutions, ou avec l'éducation aux médias.";
  assert.equal(explanationIssues(explanation, options, [0], stem), null);
});

test("aucune des trois tournures ne déclenche de faux positif sans la notion absente", () => {
  const sain = { ...CHERCHEURS, explanation: "Les chercheurs universitaires ont mené l'étude citée dans l'article." };
  assert.equal(explanationIssues(sain.explanation, sain.options, sain.correct, sain.stem), null);
  assert.deepEqual(refutedItems(sain.explanation), []);
});

/**
 * Quasi-doublon (job 28, Q1/Q7) : même comparaison chiffrée (un grand quotidien contre une
 * encyclopédie collaborative), l'une interroge les chiffres, l'autre ce qu'ils illustrent — des
 * bonnes réponses sans un mot en commun, mais le MÊME passage source. `sameSourceFact` compare le
 * fait source lui-même, pas la bonne réponse.
 */
const COMPARAISON_CHIFFREE = {
  Q1: {
    options: ["Le grand quotidien comptait environ 150 journalistes salariés, contre 30 contributeurs réguliers pour l'encyclopédie collaborative.", "x", "y", "z"],
    correct: [0],
    notion: "Modèles de production de l'information",
    sourceFact: "L'étude comparative montre que le grand quotidien national employait environ 150 journalistes salariés à temps plein, contre seulement 30 contributeurs réguliers et non rémunérés pour l'encyclopédie collaborative, sur la même période de référence.",
  },
  Q7: {
    options: ["Que la production d'information de qualité ne dépend pas nécessairement d'un encadrement salarié important.", "x", "y", "z"],
    correct: [0],
    notion: "Motivations de la contribution bénévole",
    sourceFact: "L'étude comparative montre que le grand quotidien national employait environ 150 journalistes salariés à temps plein, contre seulement 30 contributeurs réguliers et non rémunérés pour l'encyclopédie collaborative, sur la même période de référence.",
  },
  // Une troisième question, sur un passage totalement différent, ne doit jamais être rapprochée.
  AUTRE: {
    options: ["Que les algorithmes de recommandation favorisent les contenus les plus commentés.", "x", "y", "z"],
    correct: [0],
    notion: "Algorithmes de recommandation",
    sourceFact: "Une étude distincte sur les plateformes vidéo montre que l'algorithme de recommandation favorise les contenus suscitant le plus de commentaires, indépendamment de leur fiabilité.",
  },
};

test("Q1/Q7 : même passage source, bonnes réponses sans mot commun — rapproché en mode strict, pas en mode non strict", () => {
  const { Q1, Q7 } = COMPARAISON_CHIFFREE;
  assert.ok(sameSourceFact(Q1.sourceFact, Q7.sourceFact), "le même passage chiffré doit être reconnu");
  assert.equal(sameSourceFact(COMPARAISON_CHIFFREE.AUTRE.sourceFact, Q1.sourceFact), false, "un passage sans rapport ne doit jamais être rapproché");

  // `correct` à deux indices neutralise `keyProposition` (qui exige une réponse unique) : seul le
  // critère `sameSourceFact`, celui qui nous intéresse ici, peut encore rapprocher la paire.
  const items = [Q1, Q7, COMPARAISON_CHIFFREE.AUTRE].map((it) => ({ ...it, correct: [...it.correct, 1], focusSlot: false }));
  const strict = suspectPairs(items as never, true).map(([a, b]) => `${a}-${b}`);
  assert.ok(strict.includes("0-1"), `Q1/Q7 pas soumises au contrôle des doublons en mode strict : ${strict.join(", ")}`);

  // Exception du 15/11 : programme trop court en notions (mode non strict) → réemployer le même
  // exemple sous un angle vraiment distinct reste permis, pas automatiquement soumis.
  const lenient = suspectPairs(items as never, false).map(([a, b]) => `${a}-${b}`);
  assert.ok(!lenient.includes("0-1"), `Q1/Q7 ne devraient pas être forcées en mode non strict : ${lenient.join(", ")}`);
});
