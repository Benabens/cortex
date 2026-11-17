import * as z from "zod/v4";
import { getPlanChapters, type PlanChapter } from "@/lib/course-plan";
import { FIELD_LIMITS } from "@/lib/field-limits";
import { BLOCKS_MAX, EXERCISES_MAX as WRITTEN_MAX, QCM_MAX as MCQ_MAX, resolveExamFormat } from "@/lib/exam-format";
import { mockExamJob, startGenerationJob } from "@/lib/generation";
import { activeJob, costForJob } from "@/lib/jobs";
import { log } from "@/lib/metrics";
import { redactMessage } from "@/lib/observability";
import { errorText } from "@/lib/i18n/user-error";
import { clip } from "../content";
import { courseLabel } from "../courses";
import { confirmationTokenArg, courseArg, courseRef, courseRefOf, declinedSchema, declinedSummary, examFormatOf, generationStatus, quoteSchema, quoteSummary } from "../schemas";
import { codeForStatus, defineTool, pendingResult, SPENDING_HINTS, ToolError, paidCall } from "../tool";

const output = z.object({
  status: generationStatus,
  course: courseRef,
  focus: z.string().nullable().describe("The THEMATIC emphasis sent to the generator (chapter and/or free focus)."),
  format: z.enum(["written", "mcq"]).describe("written = exercises (or essay / oral topics); mcq = multiple-choice questions."),
  exercise_count: z.number().nullable().describe("Exercises (written) or questions (mcq); null = as in the course's exam format."),
  // Pas de nouveau champ de sortie : un client qui garde la liste d'outils en cache rejette un champ
  // ajouté (« additional properties », 28/10/2026) ; le format et sa source passent dans `note`.
  note: z.string().nullable().describe("How the exam was composed when it does not come from past exams: the exam format followed and where it comes from (tell the student)."),
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
    "Generates a full mock exam in the course's real exam format: multiple choice, exercises, mixed, composite questions (scenario + sub-questions), essay or oral. " +
    "The format comes from the course's past exams, else from the format declared with set_exam_format, else from official sample questions or exam instructions found in its materials; " +
    "when none of these says what the exam looks like, the call fails with format_required and spends nothing. " +
    "format sets the type for THIS exam only (mcq = multiple-choice questions only) and takes precedence over the course's format, which is only the default. " +
    "chapter (from the course plan, e.g. \"3\") or focus adds an emphasis on a THEME, never a format (\"20 MCQ\" in focus does not make a multiple-choice exam): " +
    "1-2 questions target it, the rest keeps the exam's balance. " +
    paidCall("generation") +
    // Job 17 (14/11/2026, HUM-285) : 20 QCM ont pris 35 min, hors de l'ancienne annonce (10-20) —
    // élargie plutôt que resserrée tant qu'un examen chargé (beaucoup de questions, doublons à
    // remplacer) n'est pas mesuré sur plusieurs runs réels.
    " After confirmation, the generation runs in the background for 10-35 minutes (longer for a large exam); its progress is read with get_job_status.",
  kind: "generate",
  annotations: SPENDING_HINTS,
  userSummary: "Génère un examen blanc au format de ton vrai examen.",
  input: z.object({
    course: courseArg,
    chapter: z.union([z.number().int().positive(), z.string().min(1).max(160)]).optional()
      .describe("Chapter of the course plan to emphasise: its number (3) or title. See get_study_plan for the chapters."),
    focus: z.string().min(1).max(FIELD_LIMITS.focus).optional().describe("Free THEMATIC emphasis, e.g. \"eigenvalues and diagonalisation\" (a topic, not a format)."),
    format: z.enum(["written", "mcq", "composite"]).optional()
      .describe("Explicit format for THIS exam when the student asks for it: written (exercises), mcq (multiple-choice questions ONLY, no open question) or composite (each question = a short scenario or code excerpt followed by 3-6 sub-questions mixing single choice, code reading and short answers). Wins over the course's exam format, past exams included, which is only the default."),
    exercise_count: z.number().int().min(1).max(MCQ_MAX).optional()
      .describe(`Exercises (written, 1-${WRITTEN_MAX}), questions (mcq, 1-${MCQ_MAX}) or composite questions (1-${BLOCKS_MAX}). Default: as in the course's exam format.`),
    confirmation_token: confirmationTokenArg,
  }),
  output,
  async run(args, ctx) {
    return ctx.inCourse(args.course, async (c) => {
      let chapterFocus: string | null = null;
      if (args.chapter !== undefined) {
        const ref = String(args.chapter);
        const ch = findChapter(await getPlanChapters().catch(() => []), ref);
        if (!ch) throw new ToolError("not_found", `Chapter “${clip(ref, 60)}” was not found in this course plan. get_study_plan lists the available chapters.`);
        chapterFocus = clip(`Chapter ${ch.lectureNo ?? ch.seq}: ${ch.title}${ch.subtitle ? ` (${ch.subtitle})` : ""}`, 220);
      }
      const focus = [chapterFocus, args.focus?.trim()].filter(Boolean).join(", ") || null;
      // Même règle que la route : un sujet trop long est refusé, jamais tronqué en silence.
      if (focus && focus.length > FIELD_LIMITS.focus) {
        throw new ToolError("invalid_input", `The requested focus exceeds ${FIELD_LIMITS.focus} characters. Shorten “focus”.`);
      }
      // Format du cours (annales > déclaré > exemples officiels > infos de cours), jamais déduit du focus.
      // Un format demandé pour CET examen l'emporte, annales comprises : le format du cours n'est qu'un défaut.
      const course = await resolveExamFormat();
      const asked = args.format === "mcq" ? "qcm" as const : args.format === "written" ? "exercises" as const : args.format === "composite" ? "composite" as const : null;
      // Même résolution que la route web (lib/generation mockExamJob) : même plan, même job, même prix.
      // Le worker et le pré-check relisent la demande dans la cible du job (sinon ils reviendraient au format du cours).
      const { format, plan, jobType, target, count } = await mockExamJob({ count: args.exercise_count, focus: focus ?? undefined, asked });
      if (plan.generator === "none") {
        throw new ToolError("format_required", "The course materials do not specify the exam format. Ask the student whether it uses multiple-choice questions, exercises, an essay, or an oral exam, then record it with set_exam_format (kind, question_count, duration_min, language), or pass “format” for this exam only.");
      }
      if (plan.generator === "exercises" && (args.exercise_count ?? 0) > WRITTEN_MAX) {
        throw new ToolError("invalid_input", `A written exam can contain at most ${WRITTEN_MAX} exercises. Lower exercise_count${course.basis === "annales" ? "." : ` or request multiple-choice questions with format “mcq”, up to ${MCQ_MAX}.`}`);
      }
      const qcm = jobType === "qcm";
      const formatSummary = examFormatOf(format).summary;
      const note = course.basis === "annales"
        // « format » vaut written pour des questions composées (schéma de sortie figé, clients en cache) : la note le précise.
        ? (asked ? `Format requested for this exam: ${formatSummary}; the course’s past-exam format remains the default.` : plan.generator === "blocks" ? `Past-exam format: ${formatSummary}.` : null)
        : `This course has no past exams. Format: ${formatSummary}.`;
      const base = { course: courseRefOf(c), focus, format: qcm ? "mcq" as const : "written" as const, exercise_count: count, note, confirmation: null, declined: null, job: null };
      const track = (jobId: number) => ({ job_id: jobId, estimated_minutes: "10-35", track_with: `get_job_status with job_id=${jobId}` });

      // Un examen déjà en cours est réutilisé, comme dans l'app : rien à confirmer, rien de débité.
      const running = await activeJob(jobType);
      if (running) return { ...base, status: "already_running" as const, job: track(running.id) };

      const what = plan.generator === "qcm"
        ? `a mock exam with ${plan.qcmCount} multiple-choice questions${plan.openCount ? ` and ${plan.openCount} open question(s)` : ""}`
        : plan.generator === "blocks"
          ? `a mock exam with ${plan.blockCount} composite questions (scenario and ${plan.partsMin}–${plan.partsMax} sub-questions)`
          : `a mock exam${count ? ` with ${count} ${plan.style === "essay" ? "essay prompt(s)" : plan.style === "oral" ? "oral question(s)" : "exercises"}` : " in the past-exam format"}`;
      const decision = await ctx.confirm(
        {
          bucket: "gen",
          kind: jobType,
          costCenti: costForJob(jobType, target),
          summary: `Generate ${what}${focus ? " with the requested thematic emphasis" : ""} for ${courseLabel(c)} (10–35 min).`,
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
        }
        throw new ToolError(codeForStatus(started.status), errorText("en", started), undefined, started.code);
      }
      return { ...base, status: started.existing ? "already_running" as const : "started" as const, job: track(started.jobId) };
    });
  },
  summarize: (o) => {
    const note = o.note ? ` ${o.note}` : "";
    if (o.status === "confirmation_required" && o.confirmation) return `${quoteSummary(o.confirmation)}${note}`;
    if (o.status === "declined" && o.declined) return declinedSummary(o.declined);
    if (o.job) return `${o.status === "started" ? "Mock exam generation started" : "A mock exam is already being generated"} (job ${o.job.job_id}, 10–35 min). Track it with get_job_status.${note}`;
    return `Mock exam.${note}`;
  },
});
