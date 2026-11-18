import * as z from "zod/v4";
import { examQuestions } from "@/lib/exam";
import { activeJob, getJob, jobEta, listJobs, type Job } from "@/lib/jobs";
import { getBlockExam } from "@/lib/blocks";
import { getQcmExam } from "@/lib/qcm";
import { redactMessage } from "@/lib/observability";
import { ingestProblems } from "@/lib/ingest-report";
import { clip, htmlToText } from "../content";
import { courseArg, courseRef, courseRefOf } from "../schemas";
import { defineTool, READ_ONLY_HINTS, ToolError } from "../tool";

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
  remaining: z.string().nullable().optional().describe("Estimated time left for a running generation, based on this course’s past jobs, e.g. \"about 5 min left\"."),
});

const output = z.object({
  course: courseRef,
  job: jobOut.nullable(),
  exam: z.object({
    exam_id: z.number(),
    questions: z.array(z.object({
      number: z.number(),
      kind: z.enum(["single_choice", "multiple_choice", "open", "written"]).optional()
        .describe("single_choice / multiple_choice: options lettered in the statement; open: written answer of a multiple-choice exam; written: exercise of a written exam."),
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

/**
 * Examen à questions composées (lib/blocks) : une entrée par SOUS-QUESTION (même numérotation
 * que report_question), son scénario en tête de l'énoncé ; réponse et barème sur demande.
 */
async function blocksView(examId: number, withSolutions: boolean): Promise<ExamOut | null> {
  const exam = await getBlockExam(examId, withSolutions);
  if (!exam) return null;
  const parts = exam.blocks.flatMap((b, bi) => b.parts.map((p, pi) => ({ b, bi, p, pi })));
  return {
    exam_id: examId,
    questions: parts.slice(0, MAX_QCM).map(({ b, bi, p, pi }, i) => ({
      number: i + 1,
      kind: p.kind === "scq" ? "single_choice" as const : "written" as const,
      concept: clip(`Question ${bi + 1}${String.fromCharCode(97 + pi)} : ${b.title}`, 200),
      statement: clip(`${b.scenario}\n\n(${String.fromCharCode(97 + pi)}) [${p.points} pt] ${p.prompt}${p.code ? `\n${p.code}` : ""}${p.options.length ? `\n${p.options.map((o, k) => `${LETTERS[k] ?? k + 1}) ${o}`).join("\n")}` : ""}`, 3000),
      solution: withSolutions
        ? clip(p.kind === "scq" ? `${LETTERS[p.correct ?? -1] ?? "?"}: ${p.explanation ?? ""}` : `${p.answer ?? ""}${p.criteria?.length ? `\nRubric: ${p.criteria.map((c) => `${c.label} (${c.points} pt)`).join("; ")}` : ""}`, 3000) || null
        : null,
      verification: "reviewed_by_model" as const,
    })),
    truncated: parts.length > MAX_QCM,
  };
}

/**
 * Examen QCM terminé : énoncé + options lettrées, puis sa partie OUVERTE (qui
 * manquait : seuls les QCM sortaient) ; réponses et corrigés seulement sur demande.
 */
async function qcmView(examId: number, withSolutions: boolean): Promise<ExamOut | null> {
  const exam = await getQcmExam(examId, withSolutions);
  if (!exam) return null;
  const items = exam.items as (typeof exam.items[number] & { correct?: number[] })[];
  const qcm = items.slice(0, MAX_QCM).map((it, i) => ({
      number: i + 1,
      kind: it.type === "mcq" ? "multiple_choice" as const : "single_choice" as const,
      concept: clip(it.topic, 200),
      statement: clip(`${it.stem}\n${(it.options as string[]).map((o, k) => `${LETTERS[k] ?? k + 1}) ${o}`).join("\n")}`, 1500),
      solution: withSolutions
        ? clip(`Answer${(it.correct ?? []).length > 1 ? "s" : ""}: ${(it.correct ?? []).map((k) => LETTERS[k] ?? String(k + 1)).join(", ")}. ${it.explanation ?? ""}`.trim(), 1500)
        : null,
      // Vérifié = relu par un modèle, jamais une preuve (invariant n° 2).
      verification: it.verified ? "reviewed_by_model" as const : "not_verified" as const,
    }));
  const open = exam.open.slice(0, Math.max(0, MAX_QCM - qcm.length)).map((o, k) => ({
    number: qcm.length + k + 1,
    kind: "open" as const,
    concept: clip(o.concept, 200),
    statement: clip(htmlToText(o.statement), 3000),
    solution: withSolutions ? clip(htmlToText(o.solution), 3000) || null : null,
    // Relue par l'audit de l'architecte au mieux : jamais « prouvée ».
    verification: "not_verified" as const,
  }));
  return { exam_id: examId, questions: [...qcm, ...open], truncated: items.length + exam.open.length > MAX_QCM };
}

/**
 * Étape affichée : pour une ingestion, suivie des fichiers non lus (nom et cause). Pas de champ de
 * sortie en plus : un client qui a mis le schéma en cache rejetterait la réponse (docs/MCP.md).
 */
function stepView(j: Job): string | null {
  const unread = ingestProblems(j.report);
  const step = j.currentStep ? clip(redactMessage(j.currentStep), 200) : null;
  if (!unread.length) return step;
  const list = clip(unread.map((p) => `${p.name} (${p.short})`).join(", "), 400);
  return `${step ?? ""}${step ? " · " : ""}${unread.length} unread file(s): ${list}`;
}

function jobView(j: Job, appOrigin: string, courseId: string): z.infer<typeof jobOut> {
  const path = j.resultPath;
  const link = !path ? null : path.includes("course=") ? `${appOrigin}${path}` : `${appOrigin}${path}${path.includes("?") ? "&" : "?"}course=${encodeURIComponent(courseId)}`;
  return {
    job_id: j.id,
    type: j.type,
    status: j.status,
    progress_pct: Math.round(j.progress ?? 0),
    step: stepView(j),
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
    "Returns the status, progress and current step of a long-running job started by generate_mock_exam (typically 10-35 minutes, longer for a large exam) or prepare_course. " +
    "When a mock exam (written or multiple-choice) is done, it also returns its questions, the solutions when include_solutions is true, and a link to the exam in Cortex. " +
    "Without job_id, it returns the generation currently running and the latest ones. Read-only and free.",
  kind: "read",
  annotations: READ_ONLY_HINTS,
  userSummary: "getJobStatus",
  input: z.object({
    course: courseArg,
    job_id: z.number().int().positive().optional().describe("The job_id returned by generate_mock_exam."),
    include_solutions: z.boolean().optional().describe("Include the worked solutions of a finished mock exam (default false, so that the student can try first)."),
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
      if (!job) throw new ToolError("not_found", `No generation job ${job_id} exists in this course.`);
      let exam: z.infer<typeof output>["exam"] = null;
      // QCM : job « qcm », ou job « exam » aiguillé vers le générateur QCM par le format du cours (lib/mock-exam).
      const qcm = (job.type === "qcm" || job.type === "exam") && job.status === "done" && job.resultId ? await qcmView(job.resultId, !!include_solutions) : null;
      const blocks = !qcm && job.type === "exam" && job.status === "done" && job.resultId ? await blocksView(job.resultId, !!include_solutions) : null;
      if (qcm) {
        exam = qcm;
      } else if (blocks) {
        exam = blocks;
      } else if (job.type === "exam" && job.status === "done" && job.resultId) {
        const rows = await examQuestions(job.resultId, MAX_QUESTIONS + 1);
        exam = {
          exam_id: job.resultId,
          questions: rows.slice(0, MAX_QUESTIONS).map((r, i) => ({
            number: i + 1,
            kind: "written" as const,
            concept: clip(r.concept, 200),
            statement: clip(htmlToText(r.statementHtml), 3000),
            solution: include_solutions ? clip(htmlToText(r.solutionHtml), 3000) || null : null,
            verification: r.verification,
          })),
          truncated: rows.length > MAX_QUESTIONS,
        };
      }
      const eta = await jobEta(job).catch(() => null);
      const remaining = eta
        ? eta.late ? "Taking longer than usual; generation is still running"
        : eta.remainingMs === null ? null
        : job.status === "queued" ? `About ${Math.max(1, Math.round(eta.remainingMs / 60_000))} min once started`
        : `About ${Math.max(1, Math.round(eta.remainingMs / 60_000))} min left`
        : null;
      return { ...base, job: { ...jobView(job, ctx.appOrigin, c.id), remaining }, exam };
    });
  },
  summarize: (o) => {
    if (!o.job) return o.active ? `Generation job ${o.active.job_id} is running (${o.active.progress_pct}%).` : "No generation is running.";
    const j = o.job;
    if (j.status === "done") return `Generation job ${j.job_id} is complete.${o.exam ? ` ${o.exam.questions.length} question(s).` : ""}${(j.type === "ingest" || j.type === "prepare") && j.step ? ` ${j.step}` : ""}`;
    if (j.status === "error" || j.status === "canceled") return `Generation job ${j.job_id} ${j.status === "error" ? "failed" : "was canceled"}.`;
    return `Generation job ${j.job_id}: ${j.progress_pct}%${j.remaining ? `, ${j.remaining}` : ""}. Check again in one minute.`;
  },
});
