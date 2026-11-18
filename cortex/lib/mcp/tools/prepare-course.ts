import * as z from "zod/v4";
import { startPrepareJob } from "@/lib/generation";
import { activeJob, costForJob } from "@/lib/jobs";
import { log } from "@/lib/metrics";
import { redactMessage } from "@/lib/observability";
import { errorText } from "@/lib/i18n/user-error";
import { courseLabel } from "../courses";
import { confirmationTokenArg, courseArg, courseRef, courseRefOf, declinedSchema, declinedSummary, quoteSchema, quoteSummary } from "../schemas";
import { codeForStatus, defineTool, pendingResult, SPENDING_HINTS, ToolError, paidCall } from "../tool";

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
    "Builds a course from its materials, like \"Prepare\" in the app: ingests every material, learns the exam format from the past exams, " +
    "then builds the course plan. Running it again after adding materials updates an already prepared course. " +
    paidCall("generation") +
    " After confirmation, it runs in the background for several minutes; its progress is read with get_job_status.",
  kind: "write",
  annotations: SPENDING_HINTS,
  userSummary: "prepareCourse",
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
        { bucket: "gen", kind: "prepare", costCenti: costForJob("prepare"), summary: `Prepare ${courseLabel(c)}: ingest its materials, read the past-exam format, and build the plan. This takes several minutes.` },
        { course: c.id },
        args.confirmation_token,
      );
      const pending = pendingResult(decision, base);
      if (pending) return pending;

      const started = await startPrepareJob();
      if (!started.ok) {
        if (started.status === 500) {
          log("error", "mcp.worker_start_failed", { message: redactMessage(started.error) });
          // Débité et peut-être en file : relancer sans regarder lancerait (et débiterait) deux fois.
          throw new ToolError("internal", "Starting the course preparation failed on the server. It may have been queued: check with get_job_status (without job_id) before trying again.", undefined, started.code);
        }
        throw new ToolError(codeForStatus(started.status), `${errorText("en", started)} Nothing was charged.`, undefined, started.code);
      }
      return { ...base, status: started.existing ? "already_running" as const : "started" as const, job: track(started.jobId) };
    });
  },
  summarize: (o) => {
    if (o.status === "confirmation_required" && o.confirmation) return quoteSummary(o.confirmation);
    if (o.status === "declined" && o.declined) return declinedSummary(o.declined);
    if (o.job) return `${o.status === "started" ? "Course preparation started" : "Course preparation is already running"} for ${o.course.label} (job ${o.job.job_id}). Track it with get_job_status.`;
    return "Course preparation.";
  },
});
