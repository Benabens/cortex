import * as z from "zod/v4";
import { startPrepareJob } from "@/lib/generation";
import { log } from "@/lib/metrics";
import { redactMessage } from "@/lib/observability";
import { courseArg, courseRef, courseRefOf } from "../schemas";
import { ToolError, codeForStatus, defineTool } from "../tool";

const output = z.object({
  status: z.enum(["started", "already_running"]),
  course: courseRef,
  job: z.object({ job_id: z.number(), track_with: z.string() }),
});

export default defineTool({
  name: "prepare_course",
  title: "Prepare a course",
  description:
    "Owner only. Build a course from its materials, like \"Prepare\" in the app: ingests every material, learns the exam format from the past exams, " +
    "then builds the course plan. Runs in the background for several minutes: track it with get_job_status. " +
    "Run it again after adding materials to an already prepared course.",
  kind: "admin",
  input: z.object({ course: courseArg }),
  output,
  async run(args, ctx) {
    return ctx.inCourse(args.course, async (c) => {
      const started = await startPrepareJob();
      if (!started.ok) {
        if (started.status === 500) {
          log("error", "mcp.worker_start_failed", { message: redactMessage(started.error) });
          throw new ToolError("internal", "Le lancement de la préparation a échoué côté serveur. Elle a peut-être été mise en file : vérifie avec get_job_status avant de relancer.");
        }
        throw new ToolError(codeForStatus(started.status), started.error);
      }
      return {
        status: started.existing ? "already_running" as const : "started" as const,
        course: courseRefOf(c),
        job: { job_id: started.jobId, track_with: `get_job_status with course="${c.id}" and job_id=${started.jobId}` },
      };
    });
  },
  summarize: (o) => `${o.status === "started" ? "Préparation lancée" : "Une préparation est déjà en cours"} pour ${o.course.label} (job ${o.job.job_id}) : suis-la avec get_job_status.`,
});
