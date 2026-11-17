import { currentCourse } from "@/db/client";
import { getCourse } from "@/lib/courses";
import type { ExamQuestion } from "@/lib/exam";
import { durationOf, formatContextFor } from "@/lib/exam-format";
import type { CoverFacts, ExamForm, ExamLayout, ExamPdf } from "@/lib/exam-layout";
import { courseWords, genericPreamble, localBlockLabels, localDate, localQcmLabels, localWrittenLabels, neutralChrome, neutralCoverTex, solutionColor } from "@/lib/exam-template";

/**
 * ADAPTATEUR PARAMÉTRIQUE de la mise en page (lib/exam-layout) : la garde générique, sans aucune
 * marque d'établissement (cours, durée, total des points, champs Nom et Identifiant), en-tête et
 * pied sans marque, corrigés en bleu foncé, le tout dans la langue de l'examen. Verrouillé par
 * tests/gabarit-neutre et les empreintes de tests/exam-layout.
 */
const qPoints = (q: ExamQuestion) => q.points ?? 10;

function cover(f: CoverFacts): string {
  const w = courseWords();
  const course = getCourse(currentCourse());
  const dateTex = localDate(f.dateLabel, w);
  if (f.form === "qcm") {
    // Convention traduite : la phrase détectée dans les annales est souvent en anglais.
    const parts = [f.nQcm ? w.qcmCount(f.nQcm) : "", f.nOpen ? w.openCount(f.nOpen) : ""].filter(Boolean).join(` ${w.and} `);
    return neutralCoverTex({
      course, w, dateTex, durationMin: f.durationMin, totalPts: f.totalPts,
      instructions: [w.contains(parts, f.totalPts), ...(f.nQcm ? [`${w.qcmConvention} ${w.tick}`] : []), w.onSheet],
    });
  }
  if (f.form === "blocks") {
    return neutralCoverTex({
      course, w, dateTex, durationMin: f.durationMin, totalPts: f.totalPts,
      instructions: [w.blocks(f.n, f.totalPts), w.blocksHow, w.onSheet],
    });
  }
  const total = f.questions.reduce((s, q) => s + qPoints(q), 0);
  const fc = formatContextFor(currentCourse());
  return neutralCoverTex({
    course, w, dateTex, durationMin: durationOf(fc), totalPts: total,
    instructions: [w.exercises(f.questions.length, total), ...(fc.documents ? [w.documents[fc.documents]] : []), w.onSheet, w.readCarefully],
  });
}

function chrome(form: ExamForm, dateLabel: string): string[] {
  const id = currentCourse();
  const c = getCourse(id);
  const w = courseWords();
  const foot = String.raw`\newcommand{\FOOTDATE}{${localDate(dateLabel, w)}}`;
  if (form !== "written") return [neutralChrome(c, w), foot];
  // Hors registre : le gabarit par défaut du préambule (comportement historique de l'écrit).
  return [genericPreamble(), c.id !== id ? "" : neutralChrome(c, w), foot];
}

/** Le PDF de la mise en page paramétrique `layout`, pour le cours courant. */
export function layoutPdf(layout: ExamLayout): ExamPdf {
  const w = courseWords();
  const color = solutionColor("neutral");
  return {
    layout,
    chrome,
    cover: async (f) => cover(f),
    qcm: localQcmLabels(w, color, false),
    blocks: localBlockLabels(w, color),
    written: localWrittenLabels(w),
    logo: false,
  };
}
