import { currentCourse } from "@/db/client";
import { getCourse } from "@/lib/courses";
import { getFormatProfile, isQcmCourse } from "@/lib/format";
import { profile } from "@/lib/course-profile";

/**
 * COMPOSEUR : à partir du FORMAT réel détecté du cours (`format_profile`), propose une
 * COMPOSITION pré-remplie que l'utilisateur n'a plus qu'à éditer (« [N] QCM + [M] ouvertes » pour un cours
 * QCM ; « [N] exercices calcul/trace » pour CS-202). Rien n'est hardcodé ML : tout vient du format.
 */
export type CompositionPlan = {
  course: string;
  /** "qcm" = composeur QCM+ouvertes (cours QCM-dominant) ; "exam" = composeur calcul/trace (CS-202). */
  kind: "qcm" | "exam";
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
};

/** Composition proposée pour le cours COURANT (lue du format détecté ; jamais de valeur en dur). */
export async function getComposition(): Promise<CompositionPlan> {
  const course = currentCourse();
  const c = getCourse(course);

  if (await isQcmCourse()) {
    const fmt = (await getFormatProfile())!;
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

  // Cours calcul/trace (CS-202) : la compo = le blueprint (types pondérés des vrais finals).
  let slots: { category: string; points: number }[];
  try { slots = await profile().buildBlueprint(); } catch { slots = await profile().examSlots(); }
  const categories = Array.from(new Set(slots.map((s) => s.category)));
  const totalPoints = slots.reduce((s, x) => s + (x.points || 0), 0);
  return {
    course,
    kind: "exam",
    summary: `${c.examCode} ${c.examName} — ${c.examKind} : ${slots.length} exercices (calcul/trace : ${categories.join(", ")}), ${c.durationMin} min, ${totalPoints} pts`,
    durationMin: c.durationMin,
    totalPoints,
    exercises: slots.length,
    categories,
  };
}
