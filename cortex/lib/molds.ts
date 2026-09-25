/**
 * TAXONOMIE GÉNÉRIQUE des MOULES de questions d'examen.
 *
 * Module FEUILLE (aucun import applicatif) partagé par l'indexation des annales
 * (lib/exam-index.ts) et la détection d'ADN (lib/exam-dna.ts) — pas de cycle.
 *
 * La taxonomie est VOLONTAIREMENT générique (aucun terme de matière) : c'est le modèle,
 * en regardant les annales de CHAQUE cours, qui décide quels moules s'y appliquent et
 * dans quelles proportions. Le code ne présume rien par matière.
 */

export const MOLD_KINDS = [
  "statement_truefalse",
  "equivalence_except_one",
  "figure_reading",
  "applied_scenario",
  "formula_computation",
  "code_trace",
  "table_fill",
  "proof_analysis",
  "design",
  "derivation",
] as const;

export type MoldKind = (typeof MOLD_KINDS)[number];

/** Définitions 1-ligne (injectées dans les prompts de classification ET de génération). */
export const MOLD_DEFS: Record<MoldKind, string> = {
  statement_truefalse:
    "juger des AFFIRMATIONS (vrai/faux, « which of the following statements are true ») sans calcul substantiel",
  equivalence_except_one:
    "trouver l'INTRUS : « all of the following … EXCEPT », paires/formulations équivalentes sauf une",
  figure_reading:
    "lire/interpréter une FIGURE fournie (courbe, nuage de points, diagramme, table, graphe, automate…) pour répondre",
  applied_scenario:
    "SCÉNARIO concret/appliqué : la question ancre le concept dans une situation précise et demande un raisonnement contextualisé",
  formula_computation:
    "appliquer une formule / mener un PETIT CALCUL numérique ou symbolique jusqu'à une valeur",
  code_trace:
    "lire, TRACER ou écrire du code/pseudo-code et en déduire le comportement, la sortie ou la complexité",
  table_fill:
    "REMPLIR/compléter une table, une grille, une échelle, un tableau d'états ou de valeurs",
  proof_analysis:
    "PROUVER ou justifier rigoureusement un énoncé, analyser la correction/complexité d'une méthode",
  design:
    "CONCEVOIR un algorithme/une méthode/un protocole répondant à des contraintes données",
  derivation:
    "DÉRIVER un résultat pas à pas (gradient, récurrence, équation, expression) en montrant les étapes",
};

/** Bloc prompt prêt à l'emploi : la taxonomie, une ligne par moule. */
export function moldTaxonomyBlock(): string {
  return MOLD_KINDS.map((m) => `  - ${m} : ${MOLD_DEFS[m]}`).join("\n");
}

/** Valide un moule renvoyé par le modèle (insensible casse/espaces) ; null si hors taxonomie. */
export function normalizeMold(s: unknown): MoldKind | null {
  if (typeof s !== "string") return null;
  const k = s.trim().toLowerCase().replace(/[^a-z_]+/g, "_");
  return (MOLD_KINDS as readonly string[]).includes(k) ? (k as MoldKind) : null;
}

/** Clé de fusion d'un libellé de type de figure (libre) : minuscule, alphanumérique. */
export function figureKindKey(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Nettoie un libellé de figure renvoyé par le modèle (court, générique) ; null si vide. */
export function normalizeFigureKind(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, " ").trim().slice(0, 60);
  return t.length >= 3 ? t : null;
}
