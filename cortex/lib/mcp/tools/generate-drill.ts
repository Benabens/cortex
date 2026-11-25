import * as z from "zod/v4";
import { creditCost } from "@/lib/billing/credits";
import { startDrillJob } from "@/lib/drill-job";
import { AssistRefused } from "@/lib/billing/reserve";
import { errorText } from "@/lib/i18n/user-error";
import { activeAssistantJob, getJob, ReservationRefused, type Job } from "@/lib/jobs";
import { log } from "@/lib/metrics";
import { redactMessage } from "@/lib/observability";
import { FIELD_LIMITS } from "@/lib/field-limits";
import { dueConcepts } from "@/lib/schedule";
import { topWeaknessTopic } from "@/lib/weaknesses";
import { clip } from "../content";
import { courseLabel } from "../courses";
import { confirmationTokenArg, courseArg, courseRef, courseRefOf, declinedSchema, declinedSummary, generationStatus, quoteSchema, quoteSummary } from "../schemas";
import { codeForStatus, defineTool, pendingResult, SPENDING_HINTS, ToolError, paidCall } from "../tool";

const output = z.object({
  status: generationStatus,
  course: courseRef,
  concept: z.string(),
  confirmation: quoteSchema.nullable().describe("When status is confirmation_required: the exact cost and the token to confirm with."),
  declined: declinedSchema.nullable().describe("When status is declined: why, and the cost that was announced."),
  drill: z.object({
    statement: z.string(),
    hints: z.array(z.string()).describe("Five hints, from vague to the decisive step: reveal them one at a time."),
    solution: z.string(),
  }).nullable().describe("Always null since the question is written in the background: get_job_status returns it."),
  // Champ RACINE (seule la racine des schémas publiés tolère un champ ajouté, docs/MCP.md).
  job: z.object({
    job_id: z.number(),
    estimated_minutes: z.string(),
    track_with: z.string(),
  }).nullable().describe("When status is started or already_running: the background job that writes the question."),
});

/** Concept par défaut : le point faible le plus grave, sinon le concept le plus en retard en répétition espacée. */
async function defaultConcept(): Promise<string | null> {
  try {
    const top = await topWeaknessTopic();
    if (top) return top;
  } catch { /* pas encore de table des faiblesses */ }
  try { return (await dueConcepts(1))[0] ?? null; } catch { return null; }
}

/** Notion d'un job drill (sa cible JSON), ou null. */
function conceptOfJob(job: Pick<Job, "target">): string | null {
  try {
    const c = (JSON.parse(job.target ?? "{}") as { concept?: unknown }).concept;
    return typeof c === "string" && c.trim() ? c.trim() : null;
  } catch { return null; }
}

export default defineTool({
  name: "generate_drill",
  title: "Generate a practice question",
  description:
    "Generates ONE exam-style practice question on a concept, in the style of the course's real exams, with five progressive hints and a worked solution. " +
    "Without a concept, it targets the student's most serious weak point. " +
    paidCall("assistance") +
    " After confirmation, the question is written in the background (usually 1-3 minutes): read it with get_job_status and the returned job_id.",
  kind: "generate",
  annotations: SPENDING_HINTS,
  userSummary: "generateDrill",
  input: z.object({
    course: courseArg,
    concept: z.string().min(1).max(FIELD_LIMITS.concept).optional().describe("Concept to practise, e.g. \"diagonalisation\". Defaults to the most serious weak point."),
    confirmation_token: confirmationTokenArg,
  }),
  output,
  async run(args, ctx) {
    return ctx.inCourse(args.course, async (c) => {
      const concept = args.concept?.trim() || (await defaultConcept());
      if (!concept) throw new ToolError("invalid_input", "This course has no tracked weak point or concept due for review. Specify the concept to practise with “concept”.");
      const base = { course: courseRefOf(c), concept: clip(concept, FIELD_LIMITS.concept), confirmation: null, declined: null, drill: null, job: null };
      // Le cours dans la consigne de suivi : les job_id sont numérotés par cours.
      const track = (jobId: number) => ({ job_id: jobId, estimated_minutes: "1-3", track_with: `get_job_status with course="${c.id}" and job_id=${jobId}` });
      // Un drill déjà en cours dans ce cours est rendu tel quel : rien à confirmer, rien de débité.
      // Sa notion à lui, pas celle demandée : l'assistant ne doit pas annoncer un exercice sur un autre sujet.
      const running = await activeAssistantJob("drill");
      if (running) return { ...base, concept: clip(conceptOfJob(running) ?? concept, FIELD_LIMITS.concept), status: "already_running" as const, job: track(running.id) };
      const decision = await ctx.confirm(
        { bucket: "assist", kind: "drill", costCenti: creditCost("assist"), summary: `Generate one practice question with five hints and a worked solution on “${clip(concept, 80)}” for ${courseLabel(c)}.` },
        { course: c.id, concept },
        args.confirmation_token,
      );
      const pending = pendingResult(decision, base);
      if (pending) return pending;
      // En job (lib/drill-job) : un appel de 1 à 3 minutes faisait couper le client (CS-250, 21/11).
      // La réservation est faite ici : un refus (solde, quota, moteur absent) revient tout de suite.
      let started: Awaited<ReturnType<typeof startDrillJob>>;
      try {
        started = await startDrillJob(concept);
      } catch (e) {
        if (e instanceof AssistRefused || e instanceof ReservationRefused) throw new ToolError(codeForStatus(e.status), `${errorText("en", e)} Nothing was charged.`, undefined, e.code);
        log("error", "mcp.drill_start_failed", { message: redactMessage(e instanceof Error ? e.message : String(e)) });
        // Réservé et peut-être en file : relancer sans regarder lancerait (et débiterait) deux fois.
        throw new ToolError("internal", "Starting the practice question failed on the server. It may have been queued: check with get_job_status (without job_id) before trying again.");
      }
      const raced = started.existing ? await getJob(started.jobId).catch(() => null) : null;
      return {
        ...base,
        concept: raced ? clip(conceptOfJob(raced) ?? concept, FIELD_LIMITS.concept) : base.concept,
        status: started.existing ? "already_running" as const : "started" as const,
        job: track(started.jobId),
      };
    });
  },
  summarize: (o) => {
    if (o.status === "confirmation_required" && o.confirmation) return quoteSummary(o.confirmation);
    if (o.status === "declined" && o.declined) return declinedSummary(o.declined);
    if (o.job) return `${o.status === "started" ? "The practice question is being written" : "A practice question is already being written in this course (only one at a time; its concept is in the data)"} (job ${o.job.job_id}, usually 1–3 min). Read it with get_job_status (course="${o.course.id}", job_id=${o.job.job_id}), checking every 30 seconds or so.`;
    return "Practice question.";
  },
});
