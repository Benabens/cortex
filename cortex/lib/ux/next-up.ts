/**
 * Textes de l'Accueil « Next up ». Fonctions pures : chaque phrase ne dit que ce que le back a
 * fourni, et se raccourcit quand un fait manque (pas de « 0 fois », pas de « 0 % »).
 */
import type { Fmt } from "@/lib/i18n/format";

export type NextUpKey =
  | "final" | "addDate" | "past" | "updateDate" | "today" | "tomorrow" | "inDays"
  | "effortNever" | "effortDue" | "effortReview" | "effortHeld" | "notFallen"
  | "fallenLead" | "fallenStrong" | "fallenRestWithShare" | "fallenRest"
  | "chapterNumber" | "chapter" | "fallenRow" | "inSyllabus" | "lectureSpoken" | "shareSpoken" | "share";
export type NextUpT = (key: NextUpKey, values?: Record<string, string | number>) => string;

/** "2027-01-18" → « 18 janv. » (null si la date est illisible). */
export function shortDay(iso: string, f: Fmt): string | null {
  if (isNaN(new Date(`${iso}T00:00:00`).getTime())) return null;
  return f.date(iso, "short"); // jour seul lu à midi UTC : pas de recul d'un jour à l'est de Zurich
}

export type ExamLine =
  /** Date inconnue : la ligne porte un lien pour la saisir. */
  | { state: "missing"; text: string; action: string }
  | { state: "upcoming"; text: string }
  /** Date dépassée : un compte à rebours négatif n'informe personne, on propose de la corriger. */
  | { state: "past"; text: string; action: string };

/** La ligne « Final » de l'en-tête, selon ce qu'on sait de la date. */
export function examLine(countdown: { date: string; days: number } | null, t: NextUpT, f: Fmt): ExamLine {
  const day = countdown ? shortDay(countdown.date, f) : null;
  if (!countdown || !day) return { state: "missing", text: t("final"), action: t("addDate") };
  const { days } = countdown;
  if (days < 0) return { state: "past", text: t("past", { day }), action: t("updateDate") };
  const text = days === 0 ? t("today", { day }) : days === 1 ? t("tomorrow", { day }) : t("inDays", { days, day });
  return { state: "upcoming", text };
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
function effort(status: string, mastery: number | null, t: NextUpT, f: Fmt): string {
  if (status === "never" || mastery === null) return t("effortNever");
  if (status === "due") return t("effortDue", { mastery: f.number(mastery, 1) });
  if (mastery < MASTERED) return t("effortReview", { mastery: f.number(mastery, 1) });
  return t("effortHeld", { mastery: f.number(mastery, 1) });
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
export function reason(n: NotionFacts, t: NextUpT, f: Fmt): { lead: string; strong: string; rest: string } {
  const state = effort(n.status, n.mastery, t, f);
  if (!has(n.count)) {
    return { lead: t("notFallen", { state }), strong: "", rest: "" };
  }
  const rest = has(n.examWeight)
    ? t("fallenRestWithShare", { share: f.number(n.examWeight, 1), state })
    : t("fallenRest", { state });
  return { lead: t("fallenLead"), strong: t("fallenStrong", { count: n.count }), rest };
}

/** « Chapitre L3 : Linear Models for Classification (Part 1). » (null si la notion n'est pas rattachée). */
export function chapterLine(chapter: NotionFacts["chapter"], t: NextUpT): string | null {
  const title = chapter?.title?.trim();
  if (!title) return null;
  return chapter?.lectureNo != null ? t("chapterNumber", { number: chapter.lectureNo, title }) : t("chapter", { title });
}

/**
 * Marge d'une ligne « Ensuite » : « L11 · tombé 9 fois · 6,9 % ». Les faits absents sont omis,
 * et une notion jamais tombée n'a pas de part des finals (« au programme », sans pourcentage).
 */
export function rowFacts(n: Pick<NotionFacts, "count" | "examWeight" | "chapter">, t: NextUpT, f: Fmt): string {
  return [
    n.chapter?.lectureNo != null ? `L${n.chapter.lectureNo}` : null,
    has(n.count) ? t("fallenRow", { count: n.count }) : t("inSyllabus"),
    has(n.count) && has(n.examWeight) ? t("share", { share: f.number(n.examWeight, 1) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** La même marge, en toutes lettres pour un lecteur d'écran : « lecture 11, tombé 9 fois, 6,9 % des questions ». */
export function rowFactsSpoken(n: Pick<NotionFacts, "count" | "examWeight" | "chapter">, t: NextUpT, f: Fmt): string {
  return [
    n.chapter?.lectureNo != null ? t("lectureSpoken", { number: n.chapter.lectureNo }) : null,
    has(n.count) ? t("fallenRow", { count: n.count }) : t("inSyllabus"),
    has(n.count) && has(n.examWeight) ? t("shareSpoken", { share: f.number(n.examWeight, 1) }) : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Lien « M'entraîner » : le studio s'ouvre avec la notion déjà saisie (il ne lance rien seul). */
export const trainHref = (label: string) => `/entrainement?prefill=${encodeURIComponent(label)}`;

/** Lien « Voir dans le programme » : le Programme, ouvert sur le chapitre de la notion quand on le connaît. */
export const themeHref = (chapter: NotionFacts["chapter"]) =>
  chapter?.lectureNo != null ? `/programme?chapitre=${chapter.lectureNo}` : "/programme";
