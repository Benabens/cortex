import * as z from "zod/v4";
import { recentFeedback } from "@/lib/calibration";
import { listExams } from "@/lib/exam";
import { programOverview } from "@/lib/program";
import { clip } from "../content";
import { courseArg, courseRef, courseRefOf } from "../schemas";
import { defineTool } from "../tool";

const output = z.object({
  course: courseRef,
  mock_exams: z.array(z.object({
    exam_id: z.number(),
    created_at: z.string().nullable(),
    status: z.string(),
    questions: z.number(),
    verification_summary: z.string().nullable().describe("The generator's own verification counts (ok / fixed / removed). Not a proof: use get_job_status for per-question proof status."),
    pdf_link: z.string().nullable(),
    solutions_link: z.string().nullable(),
  })),
  practice_scores: z.array(z.object({
    topic: z.string(),
    last_score: z.number().nullable().describe("Last self-assessed score 0-10."),
    mastery: z.number().nullable().describe("Smoothed mastery 0-10."),
    attempts: z.number(),
    last_done_at: z.string().nullable(),
    next_review_at: z.string().nullable(),
  })),
  graded_feedback: z.array(z.object({
    exam_id: z.number().nullable(),
    topic: z.string().nullable(),
    verdict: z.string(),
    score: z.number().nullable(),
    created_at: z.string().nullable(),
  })),
  app_link: z.string(),
});

export default defineTool({
  name: "get_results",
  title: "Get my exam and practice results",
  description:
    "Get the student's results for a course: the mock exams Cortex generated (date, status, number of questions, verification summary, links), " +
    "their practice scores per topic (last score, mastery, attempts, next review) and their graded feedback. " +
    "Use it to review progress or to decide what to practise next. Read-only and free.",
  kind: "read",
  input: z.object({
    course: courseArg,
    limit: z.number().int().min(1).max(30).optional().describe("Maximum items per list (default 10)."),
  }),
  output,
  async run({ course, limit }, ctx) {
    const n = limit ?? 10;
    return ctx.inCourse(course, async (c) => {
      const abs = (u: string | null) => (u ? `${ctx.appOrigin}${u}` : null);
      let exams: Awaited<ReturnType<typeof listExams>> = [];
      try { exams = await listExams(); } catch { /* aucun examen encore */ }
      let topics: Awaited<ReturnType<typeof programOverview>>["topics"] = [];
      try { topics = (await programOverview()).topics; } catch { /* cours pas encore analysé */ }
      let feedback: Awaited<ReturnType<typeof recentFeedback>> = [];
      try { feedback = await recentFeedback(n); } catch { /* pas de retour noté */ }
      return {
        course: courseRefOf(c),
        mock_exams: exams.slice(0, n).map((e) => ({
          exam_id: Number(e.id),
          created_at: e.createdAt ?? null,
          status: String(e.status),
          questions: Number(e.questionCount ?? 0),
          verification_summary: e.verifySummary ? clip(String(e.verifySummary), 300) : null,
          pdf_link: abs(e.url),
          solutions_link: abs(e.solutionsUrl),
        })),
        practice_scores: topics
          .filter((t) => t.attempts > 0)
          .sort((a, b) => String(b.lastDoneAt ?? "").localeCompare(String(a.lastDoneAt ?? "")))
          .slice(0, n)
          .map((t) => ({
            topic: clip(t.label, 200), last_score: t.lastScore, mastery: t.mastery, attempts: t.attempts,
            last_done_at: t.lastDoneAt, next_review_at: t.dueAt,
          })),
        graded_feedback: feedback.map((f) => ({
          exam_id: f.examId, topic: f.topic ? clip(f.topic, 200) : null, verdict: f.verdict, score: f.score, created_at: f.createdAt,
        })),
        app_link: `${ctx.appOrigin}/examens?course=${encodeURIComponent(c.id)}`,
      };
    });
  },
  summarize: (o) => `${o.course.label} : ${o.mock_exams.length} examen(s) blanc(s) récent(s), ${o.practice_scores.length} notion(s) déjà travaillée(s).`,
});
