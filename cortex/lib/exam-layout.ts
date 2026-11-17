import { currentCourse } from "@/db/client";
import { getCourse } from "@/lib/courses";
import type { ExamQuestion } from "@/lib/exam";
import { epflPdf } from "@/lib/exam-layout-epfl";
import { layoutPdf } from "@/lib/exam-layout-pdf";
import { examTemplate } from "@/lib/exam-template";

/**
 * MISE EN PAGE D'UN EXAMEN (ExamLayout) : à quoi ressemble le PDF, séparé de ce qu'il contient
 * (`ExamFormat`, lib/exam-format). Les trois moteurs de rendu (écrit, QCM, questions composées)
 * ne lisent que ceci : garde, en-tête et pied, libellés. Défaut neutre ; variante EPFL explicite,
 * réservée aux cours de l'EPFL (cs-202 garde son empreinte canonique).
 *
 * Avant le 17/11/2026, chaque moteur décidait seul (gabarit, langue, cs-202) : le test « aucune
 * marque de l'EPFL hors EPFL » devait être écrit trois fois, et une garde oubliée en laissait passer.
 */
export type ExamLayout = {
  /** epfl : la mise en page historique de l'EPFL ; neutral : la garde générique, sans marque. */
  source: "epfl" | "neutral";
};

export const NEUTRAL_LAYOUT: ExamLayout = { source: "neutral" };
export const EPFL_LAYOUT: ExamLayout = { source: "epfl" };

/** Mise en page du cours courant : l'EPFL pour un cours de l'EPFL, le défaut neutre sinon. */
export async function examLayout(): Promise<ExamLayout> {
  return examTemplate(getCourse(currentCourse())) === "epfl" ? EPFL_LAYOUT : NEUTRAL_LAYOUT;
}

export type ExamForm = "written" | "qcm" | "blocks";

/** Ce que la garde doit dire de l'examen ; la mise en page décide comment. */
export type CoverFacts =
  | { form: "qcm"; dateLabel: string; nQcm: number; nOpen: number; totalPts: number; durationMin: number | null }
  | { form: "blocks"; dateLabel: string; n: number; totalPts: number; durationMin: number | null }
  /** `specDurationMin` : la durée écrite par le générateur, que seul cs-202 lit (texte historique). */
  | { form: "written"; dateLabel: string; questions: ExamQuestion[]; specDurationMin: number | null };

/** Libellés d'un QCM et de sa partie ouverte. */
export type QcmLabels = {
  question: (n: number) => string;
  tag: (type: "scq" | "mcq", points: number) => string;
  misconception: string;
  solution: string;
  openQuestion: (n: number) => string;
  points: (n: number) => string;
  openSolution: string;
  color: string;
  qcmPart: (withOpen: boolean) => string;
  openPart: (withQcm: boolean) => string;
  /** Saut de page avant la PREMIÈRE question ouverte (l'EPFL laisse le titre de partie seul sur sa page). */
  pageBeforeFirstOpen: boolean;
};

/** Libellés des questions composées. */
export type BlockLabels = { question: string; pts: (n: number) => string; output: string; modelAnswer: string; grading: string; solution: string; color: string };

/** Libellés du corrigé d'un examen écrit (déjà en LaTeX). */
export type WrittenLabels = { solutionsTitle: string; solutionHead: (n: number, concept: string, points: number) => string };

/**
 * Le PDF d'une mise en page : tout ce qu'un moteur écrit autour de ses questions. Interface
 * commune aux deux adaptateurs (lib/exam-layout-epfl, lib/exam-layout-pdf). À créer dans le
 * cours de l'examen (identité du cours, langue).
 */
export type ExamPdf = {
  layout: ExamLayout;
  /** Lignes entre le préambule commun et `\begin{document}` : en-tête, pied, macros, `\FOOTDATE`. */
  chrome(form: ExamForm, dateLabel: string): string[];
  cover(facts: CoverFacts): Promise<string>;
  qcm: QcmLabels;
  blocks: BlockLabels;
  written: WrittenLabels;
  /** Le logo de l'établissement est copié à côté des .tex compilés. */
  logo: boolean;
};

/** Le PDF de la mise en page `layout`, pour le cours courant. */
export function examPdf(layout: ExamLayout): ExamPdf {
  return layout.source === "epfl" ? epflPdf(layout) : layoutPdf(layout);
}
