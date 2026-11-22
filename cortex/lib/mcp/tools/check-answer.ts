import * as z from "zod/v4";
import { creditCost } from "@/lib/billing/credits";
import { AssistRefused } from "@/lib/billing/reserve";
import { CheckAlreadyRunning, startCheckJob } from "@/lib/check-job";
import { FIELD_LIMITS } from "@/lib/field-limits";
import { errorText } from "@/lib/i18n/user-error";
import { activeJob, ReservationRefused } from "@/lib/jobs";
import { log } from "@/lib/metrics";
import { redactMessage } from "@/lib/observability";
import { courseLabel } from "../courses";
import { confirmationTokenArg, courseArg, courseRef, courseRefOf, declinedSchema, declinedSummary, generationStatus, quoteSchema, quoteSummary } from "../schemas";
import { codeForStatus, defineTool, pendingResult, SPENDING_HINTS, ToolError, paidCall } from "../tool";

const output = z.object({
  status: generationStatus,
  course: courseRef,
  confirmation: quoteSchema.nullable(),
  declined: declinedSchema.nullable().describe("When status is declined: why, and the cost that was announced."),
  result: z.object({
    verdict: z.enum(["correct", "partial", "wrong"]),
    score: z.object({ earned: z.number(), total: z.number() }),
    feedback: z.string(),
    criteria: z.array(z.object({
      label: z.string(), points: z.number(), achieved: z.boolean(), essential: z.boolean(), justification: z.string(),
    })).describe("Grading rubric applied criterion by criterion."),
    correct_solution: z.string(),
  }).nullable().describe("Always null since the grading runs in the background: get_job_status returns it."),
  // Champ RACINE (seule la racine des schémas publiés tolère un champ ajouté, docs/MCP.md).
  job: z.object({
    job_id: z.number(),
    estimated_minutes: z.string(),
    track_with: z.string(),
  }).nullable().optional().describe("When status is started: the background job that grades the answer."),
});

/** Une correction déjà en cours n'est pas celle-ci : on le dit, sans devis ni débit. */
function busy(jobId: number, courseId: string): ToolError {
  return new ToolError("conflict",
    `Another answer is already being graded in this course (job ${jobId}). Read that grading with get_job_status (course="${courseId}", job_id=${jobId}), then call check_answer again. Nothing was charged.`);
}

export default defineTool({
  name: "check_answer",
  title: "Grade my answer",
  description:
    "Grades the student's answer to an exam question the way the course's examiner would: verdict, rubric criterion by criterion, score, feedback and a correct solution. " +
    "Input: the exact question and the student's answer. " +
    paidCall("assistance") +
    " After confirmation, the grading runs in the background (usually under 2 minutes): read it with get_job_status and the returned job_id.",
  kind: "generate",
  annotations: SPENDING_HINTS,
  userSummary: "checkAnswer",
  input: z.object({
    course: courseArg,
    // trim() AVANT min(1) : une réponse faite d'espaces était acceptée, corrigée sans réponse et débitée.
    statement: z.string().trim().min(1).max(FIELD_LIMITS.statement).describe("The exact question / exercise statement."),
    answer: z.string().trim().min(1).max(FIELD_LIMITS.answer).describe("The student's answer, as written."),
    confirmation_token: confirmationTokenArg,
  }),
  output,
  async run(args, ctx) {
    return ctx.inCourse(args.course, async (c) => {
      const base = { course: courseRefOf(c), confirmation: null, declined: null, result: null, job: null };
      const statement = args.statement.trim();
      const answer = args.answer.trim();
      // Une correction à la fois par cours : refusée AVANT le devis (on ne fait pas confirmer l'impossible).
      const running = await activeJob("check");
      if (running) throw busy(running.id, c.id);
      const decision = await ctx.confirm(
        { bucket: "assist", kind: "check", costCenti: creditCost("assist"), summary: `Grade an answer using ${courseLabel(c)}’s rubric.` },
        { course: c.id, statement, answer },
        args.confirmation_token,
      );
      const pending = pendingResult(decision, base);
      if (pending) return pending;
      // En job (lib/check-job) : opus et un délai de 200 s dans la requête faisaient couper le
      // client (56 s mesurées en prod le 22/11). La réservation est faite ici : un refus revient tout de suite.
      let started: { jobId: number };
      try {
        started = await startCheckJob({ statement, answer });
      } catch (e) {
        if (e instanceof CheckAlreadyRunning) throw busy(e.jobId, c.id);
        if (e instanceof AssistRefused || e instanceof ReservationRefused) throw new ToolError(codeForStatus(e.status), `${errorText("en", e)} Nothing was charged.`, undefined, e.code);
        log("error", "mcp.check_start_failed", { message: redactMessage(e instanceof Error ? e.message : String(e)) });
        // Réservé et peut-être en file : relancer sans regarder débiterait deux fois.
        throw new ToolError("internal", "Starting the grading failed on the server. It may have been queued: check with get_job_status (without job_id) before trying again.");
      }
      return {
        ...base,
        status: "started" as const,
        job: { job_id: started.jobId, estimated_minutes: "1-2", track_with: `get_job_status with course="${c.id}" and job_id=${started.jobId}` },
      };
    });
  },
  summarize: (o) => {
    if (o.status === "confirmation_required" && o.confirmation) return quoteSummary(o.confirmation);
    if (o.status === "declined" && o.declined) return declinedSummary(o.declined);
    if (o.job) return `The answer is being graded (job ${o.job.job_id}, usually under 2 min). Read the result with get_job_status (course="${o.course.id}", job_id=${o.job.job_id}), checking every 30 seconds or so.`;
    return o.result ? `Grading result: ${o.result.verdict}, ${o.result.score.earned}/${o.result.score.total}.` : "Grading.";
  },
});
