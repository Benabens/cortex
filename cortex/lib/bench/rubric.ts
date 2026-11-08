/**
 * RUBRIQUE DU JUGE DU BANC — FIGÉE et versionnée : deux runs ne se comparent que jugés par la
 * même rubrique. Toute retouche change son empreinte (tests/bench-rubric.test.ts) et impose
 * une nouvelle version : les runs jugés avant ne sont plus comparables à ceux d'après.
 */
export const RUBRIC_VERSION = "v1";

export const SOLVER_RULES = [
  "Tu es un étudiant excellent qui passe cet examen. Tu ne vois ni la clé ni l'explication.",
  "Réponds à chaque question avec les DÉFINITIONS et les FAITS des extraits du cours, jamais avec ceux d'une autre source ; à défaut d'extrait, avec ta meilleure connaissance de la matière.",
  "Pour chaque QCM, donne les indices (0…) des options que tu choisis : une seule pour une question à réponse unique, toutes celles qui sont justes pour une question à réponses multiples.",
].join("\n");

export const ITEM_RULES = [
  "Tu es un examinateur exigeant. Pour chaque question d'un examen blanc généré automatiquement (tu ne sais pas comment), tranche selon les extraits du cours fournis.",
  "key : la clé (ou le corrigé) est-elle juste ? « right » si elle est juste et la seule défendable ; « wrong » si elle est fausse, ou si une autre option est au moins aussi défendable, ou s'il manque une bonne réponse ; « unsure » seulement si les extraits ET ta connaissance de la matière ne permettent vraiment pas de trancher. Un solveur indépendant a répondu sans voir la clé : s'il diffère, cherche qui a raison, ne suis ni l'un ni l'autre par défaut.",
  "explanation : l'explication (ou le corrigé) justifie-t-elle la clé, sans contradiction ni justification d'une autre option ? « consistent » ou « inconsistent » ; « na » si aucune explication.",
  "definition : si la question repose sur une définition, est-elle celle DU COURS (pas celle d'une autre source) ? « conform », « mismatch », ou « na » si la question ne repose pas sur une définition.",
  "off_course : true si la bonne réponse ou l'explication repose sur une notion ou un fait ABSENT des extraits et que ce n'est pas une connaissance générale de la matière qu'un étudiant du cours possède ; un distracteur faux n'est pas hors cours.",
  "distractors : nombre de mauvaises options ; trivial : indices des mauvaises options qu'un étudiant qui ne connaît PAS le cours élimine quand même (absurde, hors sujet, marqueur d'absolu évident, incohérence grammaticale, longueur qui trahit).",
  "chapter : l'identifiant du chapitre du plan dont relève la question (liste fournie), ou null si aucun ne convient. notion : la notion précise testée, en quelques mots.",
  "code : si la clé dépend de la SORTIE d'un programme montré dans la question, donne { language: \"python\" | \"c\", source: le programme complet exécutable, stdin: l'entrée (souvent vide), expected: la sortie que LA CLÉ affirme } ; sinon null.",
].join("\n");

export const DUPLICATE_RULES = [
  "Deux questions sont des doublons si elles testent la même notion ou le même fait sans angle vraiment distinct (même définition demandée, même résultat, même condition).",
  "Exception : si le programme du cours compte moins de notions que l'examen n'a de questions, deux questions sur une même notion sont permises sous des angles vraiment différents.",
  "Une question reprend un examen précédent si elle pose la même question (même notion ET même angle) qu'une question déjà donnée dans un examen précédent du cours, même reformulée.",
].join("\n");

export const REJECTION_RULES = [
  "Le moteur a écarté ces questions comme « hors cours ». Pour chacune, dis si le COURS (extraits trouvés dans tout le cours) traite la notion ou le fait dont dépend la bonne réponse : in_course = true si oui (le rejet était à tort), false si le cours ne la traite vraiment pas.",
].join("\n");

/** Empreinte du texte de la rubrique : notée dans chaque verdict, figée par version dans les tests. */
export function rubricFingerprint(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("node:crypto") as typeof import("node:crypto");
  return crypto.createHash("sha256").update([SOLVER_RULES, ITEM_RULES, DUPLICATE_RULES, REJECTION_RULES].join("\n\n")).digest("hex");
}
