/**
 * Textes de l'Accueil « Next up ». Fonctions pures : chaque phrase ne dit que ce que le back a
 * fourni, et se raccourcit quand un fait manque (pas de « 0 fois », pas de « 0 % »).
 */

/** Décimales à la française : 9.2 → « 9,2 ». */
export const fr = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 1 });

/** "2027-01-18" → « 18 janv. » (null si la date est illisible). */
export function shortDay(iso: string): string | null {
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

export type ExamLine =
  /** Date inconnue : la ligne porte un lien pour la saisir. */
  | { state: "missing"; text: string; action: string }
  | { state: "upcoming"; text: string }
  /** Date dépassée : un compte à rebours négatif n'informe personne, on propose de la corriger. */
  | { state: "past"; text: string; action: string };

/** La ligne « Final » de l'en-tête, selon ce qu'on sait de la date. */
export function examLine(countdown: { date: string; days: number } | null): ExamLine {
  const day = countdown ? shortDay(countdown.date) : null;
  if (!countdown || !day) return { state: "missing", text: "Final :", action: "ajoute la date" };
  const { days } = countdown;
  if (days < 0) return { state: "past", text: `Final passé le ${day} :`, action: "mets la date à jour" };
  const when = days === 0 ? "Final aujourd’hui" : days === 1 ? "Final demain" : `Final dans ${days} jours`;
  return { state: "upcoming", text: `${when} · ${day}` };
}

export type NotionFacts = {
  /** Occurrences aux finals. */
  count: number;
  /** Part des questions des finals, en %. */
  examWeight: number;
  status: string;
  mastery: number | null;
  chapter: { lectureNo: number | null; title: string | null } | null;
};

const has = (n: number) => Number.isFinite(n) && n > 0;

/** Seuil de maîtrise du back (MASTERY_THRESHOLD) : en dessous, la notion reste à revoir. */
const MASTERED = 7;

/** Où en est l'étudiant sur la notion : jamais travaillée, révision due, à revoir, tenue. */
function effort(status: string, mastery: number | null): string {
  if (status === "never" || mastery === null) return "tu ne l’as jamais travaillée";
  if (status === "due") return `sa révision est due (${fr(mastery)}/10)`;
  if (mastery < MASTERED) return `elle reste à revoir (${fr(mastery)}/10)`;
  return `tu la tiens à ${fr(mastery)}/10`;
}

/**
 * La raison, en une phrase : combien de fois la notion est tombée, quelle part des questions
 * des finals elle représente, et où l'étudiant en est. `strong` est le morceau à mettre en gras.
 *
 * « Des questions », pas « des points » : `examWeight` est la part des exercices indexés des
 * finals (12 sur 130 → 9,2 %). Les barèmes ne sont imprimés que sur une partie des annales, on
 * ne peut donc pas parler de points sans inventer.
 *
 * Une notion jamais tombée (issue des séries ou du plan) porte quand même un poids : c'est une
 * estimation de l'analyse, pas une part des finals. On ne l'affiche pas comme un fait.
 */
export function reason(n: NotionFacts): { lead: string; strong: string; rest: string } {
  const state = effort(n.status, n.mastery);
  if (!has(n.count)) {
    return { lead: `Au programme, pas encore tombée dans les finals, et ${state}.`, strong: "", rest: "" };
  }
  const share = has(n.examWeight) ? `, ${fr(n.examWeight)} % des questions, et ${state}.` : ` et ${state}.`;
  return { lead: "Tombée ", strong: `${n.count} fois`, rest: ` dans les finals${share}` };
}

/** « Chapitre L3 : Linear Models for Classification (Part 1). » (null si la notion n'est pas rattachée). */
export function chapterLine(chapter: NotionFacts["chapter"]): string | null {
  const title = chapter?.title?.trim();
  if (!title) return null;
  return chapter?.lectureNo != null ? `Chapitre L${chapter.lectureNo} : ${title}.` : `Chapitre : ${title}.`;
}

/**
 * Marge d'une ligne « Ensuite » : « L11 · tombé 9 fois · 6,9 % ». Les faits absents sont omis,
 * et une notion jamais tombée n'a pas de part des finals (« au programme », sans pourcentage).
 */
export function rowFacts(n: Pick<NotionFacts, "count" | "examWeight" | "chapter">): string {
  return [
    n.chapter?.lectureNo != null ? `L${n.chapter.lectureNo}` : null,
    has(n.count) ? `tombé ${n.count} fois` : "au programme",
    has(n.count) && has(n.examWeight) ? `${fr(n.examWeight)} %` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** La même marge, en toutes lettres pour un lecteur d'écran : « lecture 11, tombé 9 fois, 6,9 % des questions ». */
export function rowFactsSpoken(n: Pick<NotionFacts, "count" | "examWeight" | "chapter">): string {
  return [
    n.chapter?.lectureNo != null ? `lecture ${n.chapter.lectureNo}` : null,
    has(n.count) ? `tombé ${n.count} fois` : "au programme",
    has(n.count) && has(n.examWeight) ? `${fr(n.examWeight)} % des questions` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Lien « M'entraîner » : le studio s'ouvre avec la notion déjà saisie (il ne lance rien seul). */
export const trainHref = (label: string) => `/entrainement?prefill=${encodeURIComponent(label)}`;

/** Lien « Voir le thème » : le Programme, ouvert sur le chapitre de la notion quand on le connaît. */
export const themeHref = (chapter: NotionFacts["chapter"]) =>
  chapter?.lectureNo != null ? `/programme?chapitre=${chapter.lectureNo}` : "/programme";
