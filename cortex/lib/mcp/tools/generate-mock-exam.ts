import * as z from "zod/v4";
import { getPlanChapters, type PlanChapter } from "@/lib/course-plan";
import { FIELD_LIMITS } from "@/lib/field-limits";
import { EXERCISES_MAX as WRITTEN_MAX, QCM_MAX as MCQ_MAX, planMockExam, requestedFormat, resolveExamFormat } from "@/lib/exam-format";
import { examTarget, startGenerationJob } from "@/lib/generation";
import { activeJob, costForJob } from "@/lib/jobs";
import { log } from "@/lib/metrics";
import { redactMessage } from "@/lib/observability";
import { clip } from "../content";
import { courseLabel } from "../courses";
import { confirmationTokenArg, courseArg, courseRef, courseRefOf, declinedSchema, declinedSummary, examFormatOf, examFormatSchema, generationStatus, quoteSchema, quoteSummary } from "../schemas";
import { ToolError, codeForStatus, defineTool, pendingResult } from "../tool";

const output = z.object({
  status: generationStatus,
  course: courseRef,
  focus: z.string().nullable().describe("The THEMATIC emphasis sent to the generator (chapter and/or free focus)."),
  format: z.enum(["written", "mcq"]).describe("written = exercises (or essay / oral topics); mcq = multiple-choice questions."),
  exercise_count: z.number().nullable().describe("Exercises (written) or questions (mcq); null = as in the course's exam format."),
  exam_format: examFormatSchema.describe("The course's exam format the mock exam follows, and where it comes from."),
  note: z.string().nullable().describe("How the exam was composed when it does not come from past exams (tell the student)."),
  confirmation: quoteSchema.nullable(),
  declined: declinedSchema.nullable().describe("When status is declined: why, and the cost that was announced."),
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
    "Generate a full mock exam in the course's real exam format — multiple choice, exercises, mixed, essay or oral — taken from its past exams, " +
    "else from the format the student declared (set_exam_format), else from official sample questions or exam instructions found in its materials. " +
    "If nothing says what the exam looks like, the call fails with format_required: ask the student (type, number of questions, duration) and record it with set_exam_format, " +
    "or pass format for this exam only. Optionally emphasise a chapter of the course plan (e.g. chapter \"3\") or a free focus: a THEME, never a format " +
    "(\"20 MCQ\" in focus does not make a multiple-choice exam); 1-2 questions target it, the rest keeps the exam's balance. " +
    "Costs credits (as in the app: a written exam 2 by default, +1 per 4 exercises beyond 8; a multiple-choice exam by its number of questions) and one daily generation. The first call returns the exact cost and a confirmation_token " +
    "without spending anything; ask the user in the conversation and call again with the same arguments plus confirmation_token ONLY after they explicitly approved (nothing to confirm when nothing is charged). " +
    "Generation then runs in the background for 10-20 minutes: track it with get_job_status.",
  kind: "generate",
  input: z.object({
    course: courseArg,
    chapter: z.union([z.number().int().positive(), z.string().min(1).max(160)]).optional()
      .describe("Chapter of the course plan to emphasise: its number (3) or title. See get_study_plan for the chapters."),
    focus: z.string().min(1).max(FIELD_LIMITS.focus).optional().describe("Free THEMATIC emphasis, e.g. \"eigenvalues and diagonalisation\" (a topic, not a format)."),
    format: z.enum(["written", "mcq"]).optional()
      .describe("Explicit format for THIS exam when the student asks for it: written (exercises) or mcq. Ignored when the course has past exams (their format rules). Default: the course's exam format."),
    exercise_count: z.number().int().min(1).max(MCQ_MAX).optional()
      .describe(`Exercises (written, 1-${WRITTEN_MAX}) or questions (mcq, 1-${MCQ_MAX}). Default: as in the course's exam format.`),
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
      // Format du cours (annales > déclaré > exemples officiels > infos de cours), jamais déduit du focus.
      // Un format demandé pour CET examen vaut déclaration, sauf face à des annales (l'app ne contourne pas leur format).
      const course = await resolveExamFormat();
      const asked = args.format === "mcq" ? "qcm" as const : args.format === "written" ? "exercises" as const : null;
      const format = requestedFormat(course, asked);
      // Le worker et le pré-check relisent la demande dans la cible du job (sinon ils reviendraient au format du cours).
      const askedKind = format.basis !== "annales" && asked ? asked : undefined;
      const plan = planMockExam(format, { count: args.exercise_count, focus });
      if (plan.generator === "none") {
        throw new ToolError("format_required", `${plan.reason} Demande-le à la personne, puis enregistre-le avec set_exam_format (kind, question_count, duration_min, language), ou passe format pour cet examen seulement.`);
      }
      if (plan.generator === "exercises" && (args.exercise_count ?? 0) > WRITTEN_MAX) {
        throw new ToolError("invalid_input", `Un examen écrit compte au plus ${WRITTEN_MAX} exercices : réduis exercise_count${course.basis === "annales" ? "." : `, ou demande des QCM (format "mcq", jusqu'à ${MCQ_MAX}).`}`);
      }
      const qcm = plan.generator === "qcm";
      const jobType = qcm ? "qcm" as const : "exam" as const;
      const count = qcm ? plan.qcmCount : plan.exerciseCount;
      const target = qcm
        ? JSON.stringify({ count: plan.qcmCount, openCount: plan.openCount, focus: focus ?? undefined })
        : examTarget(plan.exerciseCount ?? undefined, focus ?? undefined, askedKind);
      const note = course.basis === "annales"
        ? (args.format === "mcq" && !qcm ? "Ce cours a des annales : l'examen suit leur format, la demande de QCM n'est pas appliquée." : null)
        : `Ce cours n'a pas d'annales : format ${format.summary}.`;
      const base = { course: courseRefOf(c), focus, format: qcm ? "mcq" as const : "written" as const, exercise_count: count, exam_format: examFormatOf(format), note, confirmation: null, declined: null, job: null };
      const track = (jobId: number) => ({ job_id: jobId, estimated_minutes: "10-20", track_with: `get_job_status with job_id=${jobId}` });

      // Un examen déjà en cours est réutilisé, comme dans l'app : rien à confirmer, rien de débité.
      const running = await activeJob(jobType);
      if (running) return { ...base, status: "already_running" as const, job: track(running.id) };

      const what = qcm
        ? `un examen blanc de ${plan.qcmCount} QCM${plan.openCount ? ` + ${plan.openCount} question(s) ouverte(s)` : ""}`
        : `un examen blanc${count ? ` de ${count} ${plan.style === "essay" ? "sujet(s) d'essai" : plan.style === "oral" ? "question(s) d'oral" : "exercices"}` : " au format des annales"}`;
      const decision = await ctx.confirm(
        {
          bucket: "gen",
          costCenti: costForJob(jobType, target),
          summary: `Générer ${what}${focus ? " avec l'accent demandé" : ""} — ${courseLabel(c)} (10-20 min).`,
        },
        // Le jeton est lié à la composition EXACTE du job : si elle change (annales ajoutées entre-temps), il faut un nouveau devis.
        { course: c.id, focus, format: base.format, count, target: target ?? null },
        args.confirmation_token,
      );
      const pending = pendingResult(decision, base);
      if (pending) return pending;

      const started = await startGenerationJob(jobType, target);
      // Les refus des pré-checks et de la réservation ne débitent rien. Un worker qui ne démarre
      // pas (500) arrive APRÈS la réservation : le job reste en file (relancé par la pompe) ; son
      // message technique reste au journal, pas chez le client.
      if (!started.ok) {
        if (started.status === 500) {
          log("error", "mcp.worker_start_failed", { message: redactMessage(started.error) });
          throw new ToolError("internal", "Le lancement de la génération a échoué côté serveur. Elle a peut-être été mise en file : vérifie avec get_job_status (sans job_id) avant de relancer.");
        }
        throw new ToolError(codeForStatus(started.status), `${started.error} Rien n'a été débité.`);
      }
      return { ...base, status: started.existing ? "already_running" as const : "started" as const, job: track(started.jobId) };
    });
  },
  summarize: (o) => {
    const note = o.note ? ` ${o.note}` : "";
    if (o.status === "confirmation_required" && o.confirmation) return `${quoteSummary(o.confirmation)}${note}`;
    if (o.status === "declined" && o.declined) return declinedSummary(o.declined);
    if (o.job) return `${o.status === "started" ? "Examen blanc lancé" : "Un examen blanc est déjà en cours"} (job ${o.job.job_id}, 10-20 min) : suis-le avec get_job_status.${note}`;
    return `Examen blanc.${note}`;
  },
});
