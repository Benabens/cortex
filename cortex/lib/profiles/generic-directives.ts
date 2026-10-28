/**
 * Directives génériques (format + difficulté) pour un cours autre que cs-202.
 * PAS d'exclusions matière (cs-202 a les siennes dans lib/directives.ts) : ici on cadre
 * surtout la LANGUE, la PROFONDEUR et le RÉALISME. Le scope matière vient du study-guide
 * ingéré (staffNotesText) + des vrais examens de référence du cours.
 *
 * Deux familles de consignes : « problems » (STEM : un artefact concret creusé
 * par des sous-questions, nombres non ronds — le texte historique, inchangé) et
 * les autres (SHS, essai, oral : notions précises, études, argumentation, grille).
 * La langue est celle de l'examen (lib/exam-format), plus toujours l'anglais.
 */

/** Nom de la langue de l'examen, en majuscules (consignes) et en minuscules (« en anglais »). */
const LANGUAGE_NAMES: Record<string, [upper: string, lower: string]> = {
  fr: ["FRANÇAIS", "français"],
  en: ["ANGLAIS", "anglais"],
  de: ["ALLEMAND", "allemand"],
  it: ["ITALIEN", "italien"],
  es: ["ESPAGNOL", "espagnol"],
  pt: ["PORTUGAIS", "portugais"],
  nl: ["NÉERLANDAIS", "néerlandais"],
};

export function languageName(code: string): [upper: string, lower: string] {
  return LANGUAGE_NAMES[code] ?? LANGUAGE_NAMES.en;
}

/** Style des sujets d'un cours générique : problèmes STEM, questions de SHS, essai, oral. */
export type GenericStyle = "problems" | "humanities" | "essay" | "oral";

export function genericDirectivesBlock(examCode: string, examName: string, language = "en", style: GenericStyle = "problems"): string {
  const [LANG, lang] = languageName(language);
  const head = [
    `═══════════════════════════════════════════════════════════════════════════`,
    `CONTRAINTES DURES — ${examCode} ${examName}`,
    `═══════════════════════════════════════════════════════════════════════════`,
    ``,
    `🧩 FORMAT :`,
    `  - LANGUE : 100% ${LANG} — titres ET corps de tous les énoncés et corrigés en ${lang}.`,
    `  - Modèles de format = les VRAIS examens de référence du cours fournis (mêmes types de questions, même ton, même mise en page). N'invente pas de format : calque celui des past-exams.`,
    `  - SCOPE : ne génère QUE sur les sujets du study-guide / des notes du cours et des past-exams ci-dessous. Ne sors pas du programme.`,
  ];
  if (style === "problems") {
    return [
      ...head,
      `  - PRINCIPE DE CONSTRUCTION : chaque grosse question part d'UN SEUL artefact concret et non-trivial (un problème, une instance, un jeu de données, un algorithme) creusé par 4-7 SOUS-QUESTIONS EN ESCALIER (difficulté croissante) qui testent les INTERACTIONS entre concepts, avec AU MOINS UN VRAI PIÈGE (cas-limite, frontière). Profondeur > largeur. Pas de questions déconnectées ni de simples vrai/faux.`,
      ``,
      `📐 DIFFICULTÉ : niveau d'un vrai final EPFL — nombres NON RONDS, charge de calcul/raisonnement réelle, cas-limites. L'étudiant moyen doit transpirer.`,
      `═══════════════════════════════════════════════════════════════════════════`,
    ].join("\n");
  }
  return [
    ...head,
    `  - PRINCIPE DE CONSTRUCTION : chaque sujet part d'un élément PRÉCIS du cours — une notion avec les CONDITIONS de sa définition, un résultat d'étude (auteurs, chiffres, contexte), un mécanisme ou une tension entre acteurs — et exige de le MOBILISER pour justifier, nuancer ou critiquer. Jamais de simple restitution, jamais « classe ce cas dans la notion X » sans justification des conditions.`,
    `  - GRILLE : chaque corrigé se termine par une GRILLE DE CORRECTION (critères observables, points par critère, ce qui distingue une réponse excellente d'une réponse moyenne).`,
    style === "oral"
      ? `  - ORAL : une question principale ouverte + 2-3 RELANCES de l'examinateur qui testent la profondeur (contre-exemple, limite, lien avec une autre séance).`
      : style === "essay"
        ? `  - ESSAI : une question DISCUTABLE (pas de réponse unique), qui appelle une thèse argumentée, des contre-arguments, et des références précises au cours.`
        : `  - VARIÉTÉ : alterne compréhension fine d'une notion (une condition change, que devient la conclusion ?), lecture critique d'un résultat d'étude, argumentation courte.`,
    ``,
    `📐 DIFFICULTÉ : niveau d'un vrai examen du cours — l'étudiant qui n'a retenu que les NOMS des notions échoue ; celui qui connaît leurs conditions, les résultats des études et leurs limites réussit.`,
    `═══════════════════════════════════════════════════════════════════════════`,
  ].join("\n");
}
