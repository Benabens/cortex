/**
 * Résultat PUBLIC d'une analyse (la page partageable). Il ne porte que l'analyse — libellés,
 * poids, formes, un exemple reformulé — jamais le texte des annales : chaque chaîne vient du
 * modèle, bornée et nettoyée ici (liens et adresses retirés : une annale piégée ne fait pas
 * publier un lien sur cortexexam.com).
 */

export type ExamTopic = {
  label: string;
  /** Méthode ou technique testée. */
  method: string | null;
  /** Formes réelles des questions (QCM, preuve, calcul…), sans doublon. */
  forms: string[];
  /** Exemple de question, reformulé (jamais recopié). */
  example: string | null;
  /** Piège typique, s'il est visible. */
  trap: string | null;
  /** Nombre de questions de ce sujet dans les annales déposées. */
  occurrences: number;
  /** Nombre d'annales (sur `papers`) où il apparaît. */
  papers: number;
  /** Part des questions (%), une décimale. */
  sharePct: number;
  /** Part des points (%) quand le barème est lisible sur toutes les questions, sinon null. */
  pointsPct: number | null;
};

export type ExamTopicsResult = {
  version: 1;
  /** Matière déduite des annales par le modèle (jamais saisie par le visiteur). */
  subject: string | null;
  papers: number;
  questions: number;
  topics: ExamTopic[];
  createdAt: string;
};

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const DOMAIN_RE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|app|xyz|ru|cn|info|biz|me|co|ly|gg|link|site|online)\b\S*/gi;

/** Chaîne publiable : sans liens ni adresses, sans caractères de contrôle, espaces normalisés, bornée. */
export function publicText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .replace(URL_RE, "")
    .replace(EMAIL_RE, "")
    .replace(DOMAIN_RE, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    // Tiret long ou demi-cadratin en séparateur (« DP — knapsack ») : deux-points, règle de la DA.
    .replace(/\s+[\u2013\u2014]\s+/g, ": ")
    .trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
