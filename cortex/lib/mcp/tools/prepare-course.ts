import * as z from "zod/v4";
import { startPrepareJob } from "@/lib/generation";
import { activeJob, costForJob } from "@/lib/jobs";
import { log } from "@/lib/metrics";
import { redactMessage } from "@/lib/observability";
import { courseLabel } from "../courses";
import { confirmationTokenArg, courseArg, courseRef, courseRefOf, declinedSchema, declinedSummary, quoteSchema, quoteSummary } from "../schemas";
import { ToolError, codeForStatus, defineTool, pendingResult } from "../tool";

const output = z.object({
  status: z.enum(["confirmation_required", "declined", "started", "already_running"]),
  course: courseRef,
  confirmation: quoteSchema.nullable(),
  declined: declinedSchema.nullable().describe("When status is declined: why, and the cost that was announced."),
  job: z.object({ job_id: z.number(), track_with: z.string() }).nullable(),
});

export default defineTool({
  name: "prepare_course",
  title: "Prepare a course",
  description:
    "Build a course from its materials, like \"Prepare\" in the app: ingests every material, learns the exam format from the past exams, " +
    "then builds the course plan. Costs credits (2 by default) and one daily generation, like in the app. The first call returns the exact cost and a " +
    "confirmation_token without spending anything (or asks the user directly if the client supports it); call again with the same arguments plus " +
    "confirmation_token ONLY after the user explicitly approved. Then runs in the background for several minutes: track it with get_job_status. " +
    "Run it again after adding materials to an already prepared course.",
  kind: "write",
  spends: true,
  input: z.object({ course: courseArg, confirmation_token: confirmationTokenArg }),
  output,
  async run(args, ctx) {
    return ctx.inCourse(args.course, async (c) => {
      const base = { course: courseRefOf(c), confirmation: null, declined: null, job: null };
      const track = (jobId: number) => ({ job_id: jobId, track_with: `get_job_status with course="${c.id}" and job_id=${jobId}` });

      // Une préparation déjà en cours est réutilisée, comme dans l'app : rien à confirmer, rien de débité.
      const running = await activeJob("prepare");
      if (running) return { ...base, status: "already_running" as const, job: track(running.id) };

      const decision = await ctx.confirm(
        { bucket: "gen", costCenti: costForJob("prepare"), summary: `Préparer le cours ${courseLabel(c)} : ingestion des supports, format des annales, plan (plusieurs minutes).` },
        { course: c.id },
        args.confirmation_token,
      );
      const pending = pendingResult(decision, base);
      if (pending) return pending;

      const started = await startPrepareJob();
      if (!started.ok) {
        if (started.status === 500) {
          log("error", "mcp.worker_start_failed", { message: redactMessage(started.error) });
          throw new ToolError("internal", "Le lancement de la préparation a échoué côté serveur. Elle a peut-être été mise en file : vérifie avec get_job_status avant de relancer.");
        }
        throw new ToolError(codeForStatus(started.status), `${started.error} Rien n'a été débité.`);
      }
      return { ...base, status: started.existing ? "already_running" as const : "started" as const, job: track(started.jobId) };
    });
  },
  summarize: (o) => {
    if (o.status === "confirmation_required" && o.confirmation) return quoteSummary(o.confirmation);
    if (o.status === "declined" && o.declined) return declinedSummary(o.declined);
    if (o.job) return `${o.status === "started" ? "Préparation lancée" : "Une préparation est déjà en cours"} pour ${o.course.label} (job ${o.job.job_id}) : suis-la avec get_job_status.`;
    return "Préparation du cours.";
  },
});
