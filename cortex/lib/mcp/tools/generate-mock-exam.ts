import * as z from "zod/v4";
import { getPlanChapters, type PlanChapter } from "@/lib/course-plan";
import { FIELD_LIMITS } from "@/lib/field-limits";
import { examCostCenti, examCount, examTarget, startGenerationJob } from "@/lib/generation";
import { activeJob } from "@/lib/jobs";
import { clip } from "../content";
import { courseLabel } from "../courses";
import { confirmationTokenArg, courseArg, courseRef, courseRefOf, generationStatus, quoteSchema, quoteSummary } from "../schemas";
import { ToolError, codeForStatus, defineTool } from "../tool";

const output = z.object({
  status: generationStatus,
  course: courseRef,
  focus: z.string().nullable().describe("The emphasis sent to the generator (chapter and/or free focus)."),
  exercise_count: z.number().nullable().describe("null = the number of exercises of the course's real exams."),
  confirmation: quoteSchema.nullable(),
  job: z.object({
    job_id: z.number(),
    estimated_minutes: z.string(),
    track_with: z.string(),
  }).nullable(),
});

/** Chapitre du plan désigné par son numéro (ordre ou n° de cours) ou par son titre. */
function findChapter(chapters: PlanChapter[], ref: string): PlanChapter | undefined {
  const r = ref.trim().toLowerCase().replace(/^(chapitre|chapter|ch\.?|cours|lecture|l)\s*/i, "");
  const n = Number(r);
  if (Number.isInteger(n) && n > 0) return chapters.find((c) => c.lectureNo === n) ?? chapters.find((c) => c.seq === n);
  return chapters.find((c) => c.title.toLowerCase() === r) ?? chapters.find((c) => c.title.toLowerCase().includes(r));
}

export default defineTool({
  name: "generate_mock_exam",
  title: "Generate a mock exam",
  description:
    "Generate a full mock exam (PDF in Cortex) that follows the format of the course's real past exams, optionally emphasising a chapter of the course plan " +
    "(e.g. chapter \"3\") or a free focus: 1-2 exercises target the emphasis, the rest keeps the real exam's balance. " +
    "Costs credits (2 by default, +1 per 4 exercises beyond 8) and one daily generation. The first call returns the exact cost and a confirmation_token " +
    "without spending anything (or asks the user directly if the client supports it); call again with the same arguments plus confirmation_token ONLY after the user explicitly approved. " +
    "Generation then runs in the background for 10-20 minutes: track it with get_job_status.",
  kind: "generate",
  input: z.object({
    course: courseArg,
    chapter: z.union([z.number().int().positive(), z.string().min(1).max(160)]).optional()
      .describe("Chapter of the course plan to emphasise: its number (3) or title. See get_study_plan for the chapters."),
    focus: z.string().min(1).max(FIELD_LIMITS.focus).optional().describe("Free emphasis, e.g. \"eigenvalues and diagonalisation\"."),
    exercise_count: z.number().int().min(1).max(12).optional().describe("Number of exercises (default: as in the real exams)."),
    confirmation_token: confirmationTokenArg,
  }),
  output,
  async run(args, ctx) {
    return ctx.inCourse(args.course, async (c) => {
      let chapterFocus: string | null = null;
      if (args.chapter !== undefined) {
        const ref = String(args.chapter);
        const ch = findChapter(await getPlanChapters().catch(() => []), ref);
        if (!ch) throw new ToolError("not_found", `Chapitre « ${clip(ref, 60)} » introuvable dans le plan de ce cours : get_study_plan liste les chapitres disponibles.`);
        chapterFocus = clip(`Chapitre ${ch.lectureNo ?? ch.seq} : ${ch.title}${ch.subtitle ? ` (${ch.subtitle})` : ""}`, 220);
      }
      const focus = [chapterFocus, args.focus?.trim()].filter(Boolean).join(" — ") || null;
      // Même règle que la route : un sujet trop long est refusé, jamais tronqué en silence.
      if (focus && focus.length > FIELD_LIMITS.focus) {
        throw new ToolError("invalid_input", `Le sujet demandé dépasse ${FIELD_LIMITS.focus} caractères : raccourcis « focus ».`);
      }
      const count = examCount(args.exercise_count) ?? null;
      const base = { course: courseRefOf(c), focus, exercise_count: count, confirmation: null, job: null };
      const track = (jobId: number) => ({ job_id: jobId, estimated_minutes: "10-20", track_with: `get_job_status with job_id=${jobId}` });

      // Un examen déjà en cours est réutilisé, comme dans l'app : rien à confirmer, rien de débité.
      const running = await activeJob("exam");
      if (running) return { ...base, status: "already_running" as const, job: track(running.id) };

      const target = examTarget(count ?? undefined, focus ?? undefined);
      const decision = await ctx.confirm(
        {
          bucket: "gen",
          costCenti: examCostCenti(target),
          summary: `Générer un examen blanc${count ? ` de ${count} exercices` : " au format des annales"}${focus ? " avec l'accent demandé" : ""} — ${courseLabel(c)} (10-20 min).`,
        },
        { course: c.id, focus, count },
        args.confirmation_token,
      );
      if (decision.kind === "input_required") return decision.result;
      if (decision.kind === "quote") return { ...base, status: "confirmation_required" as const, confirmation: decision.quote };
      if (decision.kind === "declined") return { ...base, status: "declined" as const };

      const started = await startGenerationJob("exam", target);
      // Les refus des pré-checks et de la réservation ne débitent rien ; un worker qui ne démarre pas (500), si : le job reste en file.
      if (!started.ok) throw new ToolError(codeForStatus(started.status), started.status === 500 ? started.error : `${started.error} Rien n'a été débité.`);
      return { ...base, status: started.existing ? "already_running" as const : "started" as const, job: track(started.jobId) };
    });
  },
  summarize: (o) => {
    if (o.status === "confirmation_required" && o.confirmation) return quoteSummary(o.confirmation);
    if (o.status === "declined") return "Génération refusée par la personne : rien n'a été débité.";
    if (o.job) return `${o.status === "started" ? "Examen blanc lancé" : "Un examen blanc est déjà en cours"} (job ${o.job.job_id}, 10-20 min) : suis-le avec get_job_status.`;
    return "Examen blanc.";
  },
});
