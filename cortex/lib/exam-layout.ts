import { currentCourse } from "@/db/client";
import { getCourse } from "@/lib/courses";
import type { ExamQuestion } from "@/lib/exam";
import { epflPdf } from "@/lib/exam-layout-epfl";
import { layoutPdf } from "@/lib/exam-layout-pdf";
import { formatContextFor, LANGUAGES, readStoredProfile, type Language } from "@/lib/exam-format";
import type { SurveyedLayout } from "@/lib/exam-layout-survey";
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
/** Un champ à remplir de la garde ; `label` : le libellé de l'annale (texte brut), null = celui de la langue de l'examen. */
export type IdKind = "name" | "firstName" | "studentId" | "signature" | "seat";
export type IdField = { kind: IdKind; label: string | null };
/** Contenu d'une case d'en-tête ou de pied de page. */
export type PageSlot = "course" | "examKind" | "page" | "pageOfTotal" | "date" | "none";
export type Slots = { left: PageSlot; center: PageSlot; right: PageSlot };
/** `prefix` : le mot de l'annale (« Exercice », « Problem », « Q ») ; "" = le numéro seul ; null = « Question » dans la langue de l'examen. */
export type Numbering = { prefix: string | null; style: "arabic" | "roman" };
export type ChoiceLabel = "A." | "A)" | "(A)" | "a." | "a)" | "(a)";
export type ChoiceMark = "box" | "bubble" | "none";

export type ExamLayout = {
  /** epfl : la mise en page historique de l'EPFL ; neutral : la garde générique, sans marque ; annale : relevée dans l'annale du cours. */
  source: "epfl" | "neutral" | "annale";
  cover: {
    idFields: IdField[];
    /** Consignes de l'annale (texte brut), après la ligne qui dit ce que contient l'examen ; vide = les consignes génériques. */
    instructions: string[];
    /** Tableau des points par question, à remplir par le correcteur. */
    pointsTable: boolean;
  };
  header: Slots;
  footer: Slots;
  numbering: Numbering;
  /** Options de QCM : lettre, marque à cocher, une ou deux colonnes (énoncé seulement). */
  choices: { label: ChoiceLabel; mark: ChoiceMark; columns: 1 | 2 };
  /** standard : la place historique de chaque moteur ; margin : à droite du titre ; inline : entre parenthèses ; none : absents. */
  points: "standard" | "margin" | "inline" | "none";
  /** Police du corps (Latin Modern, avec ou sans empattements) et taille de la classe, en points. */
  font: { family: "serif" | "sans"; size: 10 | 11 | 12 };
  /** Espace de réponse des questions ouvertes : lignes, cadre, ou blanc de même hauteur. */
  answerSpace: "lines" | "box" | "blank";
};

/** Le défaut : le gabarit neutre de #116, à l'octet près (empreintes de tests/exam-layout). */
export const NEUTRAL_LAYOUT: ExamLayout = {
  source: "neutral",
  cover: { idFields: [{ kind: "name", label: null }, { kind: "studentId", label: null }], instructions: [], pointsTable: false },
  header: { left: "course", center: "none", right: "page" },
  footer: { left: "none", center: "examKind", right: "date" },
  numbering: { prefix: null, style: "arabic" },
  choices: { label: "A.", mark: "box", columns: 1 },
  points: "standard",
  font: { family: "serif", size: 11 },
  answerSpace: "lines",
};

/** L'EPFL : son adaptateur ne lit que `source` ; garde, chrome et options restent les siens. */
export const EPFL_LAYOUT: ExamLayout = { ...NEUTRAL_LAYOUT, source: "epfl" };

/**
 * Mise en page du cours courant : l'EPFL pour un cours de l'EPFL ; hors EPFL, celle relevée dans
 * l'annale à la préparation du cours (stockée avec le profil de format), sinon le défaut neutre.
 */
export async function examLayout(): Promise<ExamLayout> {
  const id = currentCourse();
  if (examTemplate(getCourse(id)) === "epfl") return EPFL_LAYOUT;
  const surveyed = (await readStoredProfile())?.layout;
  return surveyed ? annaleLayout(surveyed, examLanguage(id)) : NEUTRAL_LAYOUT;
}

/** Langue des libellés de l'examen (celle de courseWords : l'anglais quand elle n'est pas reconnue). */
function examLanguage(id: string): Language {
  const l = formatContextFor(id).language;
  return (LANGUAGES as readonly string[]).includes(l) ? (l as Language) : "en";
}

/**
 * La mise en page relevée, champ par champ sur le défaut neutre. Les consignes de l'annale ne
 * s'impriment que sur un examen de leur langue (une garde française ne cite pas l'anglais).
 */
export function annaleLayout(s: SurveyedLayout, language: Language): ExamLayout {
  const cover = { ...NEUTRAL_LAYOUT.cover, ...s.cover };
  if (s.language !== language) cover.instructions = [];
  return {
    source: "annale",
    cover,
    header: s.header ?? NEUTRAL_LAYOUT.header,
    footer: s.footer ?? NEUTRAL_LAYOUT.footer,
    numbering: s.numbering ?? NEUTRAL_LAYOUT.numbering,
    choices: s.choices ?? NEUTRAL_LAYOUT.choices,
    points: s.points ?? NEUTRAL_LAYOUT.points,
    font: s.font ?? NEUTRAL_LAYOUT.font,
    answerSpace: s.answerSpace ?? NEUTRAL_LAYOUT.answerSpace,
  };
}

export type ExamForm = "written" | "qcm" | "blocks";

/** Ce que la garde doit dire de l'examen ; la mise en page décide comment. `points` : ceux de chaque question, dans l'ordre. */
export type CoverFacts =
  | { form: "qcm"; dateLabel: string; nQcm: number; nOpen: number; totalPts: number; durationMin: number | null; points: number[] }
  | { form: "blocks"; dateLabel: string; n: number; totalPts: number; durationMin: number | null; points: number[] }
  /** `specDurationMin` : la durée écrite par le générateur, que seul cs-202 lit (texte historique). */
  | { form: "written"; dateLabel: string; questions: ExamQuestion[]; specDurationMin: number | null };

/** Libellés d'un QCM et de sa partie ouverte. */
export type QcmLabels = {
  /** Le mot des titres (« Question », « Open question »), quand la numérotation de l'annale en change le numéro. */
  questionWord: string;
  openWord: string;
  question: (n: number) => string;
  tag: (type: "scq" | "mcq", points: number) => string;
  /** Le type seul (« single choice »), quand les points ne sont pas dans l'étiquette. */
  kind: (type: "scq" | "mcq") => string;
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
  /** Le préambule commun (latex/preamble.tex) adapté : taille de la classe. */
  preamble(src: string): string;
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
