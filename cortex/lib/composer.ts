import { currentCourse } from "@/db/client";
import { getCourse } from "@/lib/courses";
import { getFormatProfile } from "@/lib/format";
import { planMockExam, resolveExamFormat } from "@/lib/exam-format";
import { profile } from "@/lib/course-profile";

/**
 * COMPOSEUR : à partir du FORMAT réel détecté du cours (`format_profile`), propose une
 * COMPOSITION pré-remplie que l'utilisateur n'a plus qu'à éditer (« [N] QCM + [M] ouvertes » pour un cours
 * QCM ; « [N] exercices calcul/trace » pour CS-202). Rien n'est hardcodé ML : tout vient du format.
 */
export type CompositionPlan = {
  course: string;
  /**
   * "qcm" = composeur QCM+ouvertes ; "exam" = composeur d'exercices (calcul/trace, essai, oral) ;
   * "unknown" = format d'examen inconnu : rien à composer, `summary` dit quoi déclarer.
   */
  kind: "qcm" | "exam" | "unknown";
  /** Phrase de transparence : ce qui a été détecté. */
  summary: string;
  durationMin: number;
  totalPoints: number | null;
  // kind === "qcm"
  qcm?: number;   // défaut = nb de SCQ+MCQ détectés
  open?: number;  // défaut = nb d'ouvertes détectées
  scq?: number;
  mcq?: number;
  // kind === "exam"
  exercises?: number;  // défaut = nb d'exercices du blueprint
  categories?: string[];
  /** Ce qu'on compte : « exercice » (problèmes), « sujet » (essai), « question » (oral). */
  unit?: "exercice" | "sujet" | "question";
};

/** Composition proposée pour le cours COURANT (lue du format détecté ; jamais de valeur en dur). */
export async function getComposition(): Promise<CompositionPlan> {
  const course = currentCourse();
  const c = getCourse(course);

  // Le MÊME aiguillage que le worker et le connecteur (lib/exam-format).
  const format = await resolveExamFormat();
  const plan = planMockExam(format, {});
  if (plan.generator === "none") {
    return { course, kind: "unknown", summary: plan.reason, durationMin: c.durationMin, totalPoints: null };
  }

  const fmt = format.basis === "annales" ? await getFormatProfile() : null;
  if (plan.generator === "qcm" && !fmt) {
    // Format déclaré ou lu dans les sources (pas d'annale) : la composition vient de lui.
    return {
      course,
      kind: "qcm",
      summary: format.summary,
      durationMin: format.durationMin || c.durationMin,
      totalPoints: null,
      qcm: plan.qcmCount,
      open: plan.openCount,
      scq: plan.qcmCount,
      mcq: 0,
    };
  }
  if (plan.generator === "qcm" && fmt) {
    const types = fmt.question_types ?? [];
    const sum = (t: string) => types.filter((x) => x.type === t).reduce((s, x) => s + (x.approx_count || 0), 0);
    const scq = sum("scq");
    const mcq = sum("mcq");
    const open = sum("open");
    const qcm = scq + mcq;
    return {
      course,
      kind: "qcm",
      summary: fmt.format_summary || `${c.examCode} : ~${qcm} QCM (SCQ+MCQ) + ~${open} ouvertes`,
      durationMin: fmt.duration_min || c.durationMin,
      totalPoints: fmt.total_points ?? null,
      qcm: qcm || 12,
      open,
      scq,
      mcq,
    };
  }

  // Cours à exercices (CS-202 : calcul/trace) : la compo = le blueprint (types pondérés des vrais finals).
  let slots: { category: string; points: number }[];
  try { slots = await profile().buildBlueprint(); } catch { slots = await profile().examSlots(); }
  const categories = Array.from(new Set(slots.map((s) => s.category)));
  const totalPoints = slots.reduce((s, x) => s + (x.points || 0), 0);
  const style = plan.generator === "exercises" ? plan.style : "problems";
  const exercises = (plan.generator === "exercises" ? plan.exerciseCount : null) ?? slots.length;
  return {
    course,
    kind: "exam",
    summary: format.basis === "annales"
      ? `${c.examCode} ${c.examName} — ${c.examKind} : ${slots.length} exercices (calcul/trace : ${categories.join(", ")}), ${c.durationMin} min, ${totalPoints} pts`
      : format.summary,
    durationMin: format.durationMin || c.durationMin,
    totalPoints,
    exercises,
    categories,
    unit: style === "essay" ? "sujet" : style === "oral" ? "question" : "exercice",
  };
}
