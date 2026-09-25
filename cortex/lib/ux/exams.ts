/**
 * Types Examens — formes réelles (curl) :
 * GET /api/compose → { plan } — VARIABLE selon le cours :
 *   kind "qcm"  (ml, algo)  : { course, kind, summary, durationMin, totalPoints, qcm, open, scq, mcq }
 *   kind "exam" (cs-202)    : { course, kind, summary, durationMin, totalPoints, exercises, categories[] }
 * GET /api/exams → { exams[], schedule } (500 possible sur cs-202 — géré à l'écran).
 * POST /api/qcm/generate {count, openCount, focus?} → JOB · POST /api/exams/generate {count?} → JOB.
 */

export type PlanQcm = {
  course: string;
  kind: "qcm";
  summary: string;
  durationMin: number;
  totalPoints: number;
  qcm: number;
  open: number;
  scq: number;
  mcq: number;
};

export type PlanExam = {
  course: string;
  kind: "exam";
  summary: string;
  durationMin: number;
  totalPoints: number;
  exercises: number;
  categories: string[];
};

export type Plan = PlanQcm | PlanExam;
export type ComposeResp = { plan: Plan | null };

export type ExamRow = {
  id: number;
  createdAt: string;
  status: string;
  questionCount: number;
  verifySummary: unknown;
  url: string | null;
  solutionsUrl: string | null;
};

export type ExamsResp = {
  exams: ExamRow[];
  schedule: { total: number; due: number };
};
