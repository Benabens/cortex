/**
 * Types Entraînement — formes réelles :
 * GET /api/drill → { due: string[] (concepts dus, libellés), weaknesses: string[] } (500 sur cs-202).
 * POST /api/drill {concept} → { ok, jobId } : le job écrit l’exercice, lu sur GET /api/jobs/[id] (champ drill).
 * POST /api/exercises/generate {target} | multipart {target?, note?, image?} → JOB.
 * GET /api/labs/generate → { series:[{ lab:{id,label}, exams:[…] }] } (contenu Labs = cs-202).
 * POST /api/labs/generate {lab?|topic?} → JOB.
 * POST /api/feedback {examId?, topic?, verdict: too_easy|good|not_prof_style|wrong, note?}.
 */

export type DrillListResp = { due: string[]; weaknesses: string[] };

export type Drill = {
  concept: string;
  statement_html: string;
  hints: string[];
  solution_html: string;
};

export type LabEntry = {
  lab: { id: string; label: string };
  exams: Array<Record<string, unknown>>;
};
export type LabsResp = { series: LabEntry[] };

export const FEEDBACK_OPTIONS = [
  { verdict: "good", labelKey: "feedbackGood" },
  { verdict: "too_easy", labelKey: "feedbackTooEasy" },
  { verdict: "not_prof_style", labelKey: "feedbackNotTeacherStyle" },
  { verdict: "wrong", labelKey: "feedbackWrong" },
] as const;

/** resultPath d'un job (chemin serveur) → lien /exam/<fichier> si c'est un PDF connu. */
export function examLinkFromResultPath(resultPath: string | null, courseId: string): string | null {
  if (!resultPath || !resultPath.endsWith(".pdf")) return null;
  const base = resultPath.split("/").pop();
  if (!base) return null;
  return `/exam/${base}?course=${encodeURIComponent(courseId)}`;
}
