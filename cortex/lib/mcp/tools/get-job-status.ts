import * as z from "zod/v4";
import { examQuestions } from "@/lib/exam";
import { activeJob, getJob, listJobs, type Job } from "@/lib/jobs";
import { getQcmExam } from "@/lib/qcm";
import { redactMessage } from "@/lib/observability";
import { clip, htmlToText } from "../content";
import { courseArg, courseRef, courseRefOf } from "../schemas";
import { ToolError, defineTool } from "../tool";

const jobOut = z.object({
  job_id: z.number(),
  type: z.string(),
  status: z.enum(["queued", "running", "verifying", "compiling", "done", "error", "canceled"]),
  progress_pct: z.number(),
  step: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  result_link: z.string().nullable(),
});

const output = z.object({
  course: courseRef,
  job: jobOut.nullable(),
  exam: z.object({
    exam_id: z.number(),
    questions: z.array(z.object({
      number: z.number(),
      concept: z.string(),
      statement: z.string(),
      solution: z.string().nullable(),
      verification: z.enum(["proven", "reviewed_by_model", "not_verified"])
        .describe("proven = answer checked by deterministic execution/comparison; reviewed_by_model = only re-read by a model (NOT a proof); not_verified."),
    })),
    truncated: z.boolean(),
  }).nullable().describe("Present when a mock-exam job (written or multiple-choice) is done."),
  active: jobOut.nullable().describe("Without job_id: the generation currently running, if any."),
  recent: z.array(jobOut).describe("Without job_id: the latest generations."),
});

const MAX_QUESTIONS = 12;
/** Un examen QCM compte jusqu'à 40 questions, plus courtes qu'un exercice. */
const MAX_QCM = 40;
const LETTERS = "ABCDEFGHIJ";

type ExamOut = NonNullable<z.infer<typeof output>["exam"]>;

/** Examen QCM terminé : énoncé + options lettrées ; réponses et explication seulement sur demande. */
async function qcmView(examId: number, withSolutions: boolean): Promise<ExamOut | null> {
  const exam = await getQcmExam(examId, withSolutions);
  if (!exam) return null;
  const items = exam.items as (typeof exam.items[number] & { correct?: number[] })[];
  return {
    exam_id: examId,
    questions: items.slice(0, MAX_QCM).map((it, i) => ({
      number: i + 1,
      concept: clip(it.topic, 200),
      statement: clip(`${it.stem}\n${(it.options as string[]).map((o, k) => `${LETTERS[k] ?? k + 1}) ${o}`).join("\n")}`, 1500),
      solution: withSolutions
        ? clip(`Réponse${(it.correct ?? []).length > 1 ? "s" : ""} : ${(it.correct ?? []).map((k) => LETTERS[k] ?? String(k + 1)).join(", ")}. ${it.explanation ?? ""}`.trim(), 1500)
        : null,
      // Vérifié = relu par un modèle, jamais une preuve (invariant n° 2).
      verification: it.verified ? "reviewed_by_model" as const : "not_verified" as const,
    })),
    truncated: items.length > MAX_QCM,
  };
}

function jobView(j: Job, appOrigin: string, courseId: string): z.infer<typeof jobOut> {
  const path = j.resultPath;
  const link = !path ? null : path.includes("course=") ? `${appOrigin}${path}` : `${appOrigin}${path}${path.includes("?") ? "&" : "?"}course=${encodeURIComponent(courseId)}`;
  return {
    job_id: j.id,
    type: j.type,
    status: j.status,
    progress_pct: Math.round(j.progress ?? 0),
    step: j.currentStep ? clip(j.currentStep, 200) : null,
    error: j.error ? clip(redactMessage(j.error), 300) : null,
    created_at: j.createdAt,
    updated_at: j.updatedAt,
    result_link: j.status === "done" && link && /^\/(exam|mock)\//.test(j.resultPath ?? "") ? link : null,
  };
}

export default defineTool({
  name: "get_job_status",
  title: "Track a generation",
  description:
    "Track a long-running generation started with generate_mock_exam (typically 10-20 minutes): status, progress and current step. " +
    "When the mock exam (written or multiple-choice) is done, returns its questions (and the solutions if include_solutions is true) plus a link to it in Cortex. " +
    "Without job_id, returns the generation currently running and the latest ones. Poll at most every 30-60 seconds. Read-only and free.",
  kind: "read",
  input: z.object({
    course: courseArg,
    job_id: z.number().int().positive().optional().describe("The job_id returned by generate_mock_exam."),
    include_solutions: z.boolean().optional().describe("Include the worked solutions of a finished mock exam (default false: let the student try first)."),
  }),
  output,
  async run({ course, job_id, include_solutions }, ctx) {
    return ctx.inCourse(course, async (c) => {
      const base = { course: courseRefOf(c), job: null, exam: null, active: null, recent: [] as z.infer<typeof jobOut>[] };
      if (job_id === undefined) {
        const active = await activeJob();
        return { ...base, active: active ? jobView(active, ctx.appOrigin, c.id) : null, recent: (await listJobs(5)).map((j) => jobView(j, ctx.appOrigin, c.id)) };
      }
      const job = await getJob(job_id);
      if (!job) throw new ToolError("not_found", `Aucune génération n° ${job_id} dans ce cours.`);
      let exam: z.infer<typeof output>["exam"] = null;
      if (job.type === "qcm" && job.status === "done" && job.resultId) {
        exam = await qcmView(job.resultId, !!include_solutions);
      } else if (job.type === "exam" && job.status === "done" && job.resultId) {
        const rows = await examQuestions(job.resultId, MAX_QUESTIONS + 1);
        exam = {
          exam_id: job.resultId,
          questions: rows.slice(0, MAX_QUESTIONS).map((r, i) => ({
            number: i + 1,
            concept: clip(r.concept, 200),
            statement: clip(htmlToText(r.statementHtml), 3000),
            solution: include_solutions ? clip(htmlToText(r.solutionHtml), 3000) || null : null,
            verification: r.verification,
          })),
          truncated: rows.length > MAX_QUESTIONS,
        };
      }
      return { ...base, job: jobView(job, ctx.appOrigin, c.id), exam };
    });
  },
  summarize: (o) => {
    if (!o.job) return o.active ? `Génération n° ${o.active.job_id} en cours (${o.active.progress_pct} %).` : "Aucune génération en cours.";
    const j = o.job;
    if (j.status === "done") return `Génération n° ${j.job_id} terminée.${o.exam ? ` ${o.exam.questions.length} question(s).` : ""}`;
    if (j.status === "error" || j.status === "canceled") return `Génération n° ${j.job_id} : ${j.status === "error" ? "échec" : "annulée"}.`;
    return `Génération n° ${j.job_id} : ${j.progress_pct} % — repasse dans une minute.`;
  },
});
