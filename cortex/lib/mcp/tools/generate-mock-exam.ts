import * as z from "zod/v4";
import { getPlanChapters, type PlanChapter } from "@/lib/course-plan";
import { FIELD_LIMITS } from "@/lib/field-limits";
import { q } from "@/db/q";
import { examTarget, startGenerationJob } from "@/lib/generation";
import { activeJob, costForJob } from "@/lib/jobs";
import { log } from "@/lib/metrics";
import { redactMessage } from "@/lib/observability";
import { clip } from "../content";
import { courseLabel } from "../courses";
import { confirmationTokenArg, courseArg, courseRef, courseRefOf, declinedSchema, declinedSummary, generationStatus, quoteSchema, quoteSummary } from "../schemas";
import { ToolError, codeForStatus, defineTool, pendingResult } from "../tool";

const output = z.object({
  status: generationStatus,
  course: courseRef,
  focus: z.string().nullable().describe("The emphasis sent to the generator (chapter and/or free focus)."),
  format: z.enum(["written", "mcq"]).describe("written = exercises like the real exams; mcq = multiple-choice questions."),
  exercise_count: z.number().nullable().describe("Exercises (written) or questions (mcq); null = as many as in the course's real exams."),
  note: z.string().nullable().describe("How the exam was composed when the course has no past exams (tell the student)."),
  confirmation: quoteSchema.nullable(),
  declined: declinedSchema.nullable().describe("When status is declined: why, and the cost that was announced."),
  job: z.object({
    job_id: z.number(),
    estimated_minutes: z.string(),
    track_with: z.string(),
  }).nullable(),
});

/** Sans annales : composition par défaut (exercices écrits, ou QCM). */
const WRITTEN_DEFAULT = 6;
const MCQ_DEFAULT = 20;
const WRITTEN_MAX = 12;
const MCQ_MAX = 40;
/** Un focus qui demande des QCM (« ~20 QCM », « multiple choice »…). */
const MCQ_WORDS = /\b(qcm|mcq|multiple[- ]choice|choix multiples?)\b/i;

export type MockExamPlan = {
  format: "written" | "mcq";
  /** Type de job : « exam » (générateur d'examen écrit) ou « qcm » (générateur QCM). */
  jobType: "exam" | "qcm";
  /** Exercices (écrit) ou questions (QCM) ; null = comme les annales. */
  count: number | null;
  /** Cible du job telle que le worker la lit (absente = défauts du moteur). */
  target?: string;
  /** Ce qui a été décidé faute d'annales, à dire à la personne ; null avec des annales. */
  note: string | null;
};

/**
 * COMPOSITION D'UN EXAMEN BLANC. Avec des annales, leur format fait la règle (le focus
 * n'est qu'un accent) — sauf format demandé explicitement. SANS annales, rien ne dit à
 * quoi ressemble l'examen : on suit la demande — QCM si `format` ou le focus le disent,
 * nombre `count` — avec un défaut raisonnable, et on le dit (27/10/2026 : « ~20 QCM »
 * sur HUM-285 donnait UN exercice, le blueprint d'un cours sans annales n'ayant qu'un créneau).
 */
export function planMockExam(a: { format?: "written" | "mcq"; count?: number; focus: string | null; hasPastExams: boolean }): MockExamPlan | { error: string } {
  const focus = a.focus?.trim() || null;
  const format = a.format ?? (!a.hasPastExams && focus && MCQ_WORDS.test(focus) ? "mcq" : "written");
  const defaulted = a.count === undefined;
  if (format === "mcq") {
    const count = Math.min(MCQ_MAX, a.count ?? MCQ_DEFAULT);
    const target = JSON.stringify(a.hasPastExams ? { count, focus: focus ?? undefined } : { count, openCount: 0, focus: focus ?? undefined });
    const note = a.hasPastExams ? null
      : `Ce cours n'a pas d'annales : examen composé selon la demande, ${count} QCM${defaulted ? " (nombre par défaut)" : ""}.`;
    return { format, jobType: "qcm", count, target, note };
  }
  if (a.count !== undefined && a.count > WRITTEN_MAX) {
    return { error: `Un examen écrit compte au plus ${WRITTEN_MAX} exercices : réduis exercise_count, ou demande des QCM (format "mcq", jusqu'à ${MCQ_MAX}).` };
  }
  const count = a.count ?? (a.hasPastExams ? null : WRITTEN_DEFAULT);
  const note = a.hasPastExams ? null
    : `Ce cours n'a pas d'annales : ${count} exercices écrits${defaulted ? " (nombre par défaut)" : ""}, format générique faute d'examens réels.`;
  return { format, jobType: "exam", count, target: examTarget(count ?? undefined, focus ?? undefined), note };
}

/** Le cours a-t-il des annales (finals, partiels) ingérées ? Table absente (cours neuf) = non. */
async function pastExamCount(): Promise<number> {
  try {
    return Number((await q.get<{ n: number }>(`SELECT count(*) n FROM sources WHERE type IN ('final','midterm')`))?.n ?? 0);
  } catch {
    return 0;
  }
}

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
    "For a course WITHOUT past exams, the format and number asked for are used as is (e.g. format \"mcq\" with exercise_count 20; defaults 6 exercises or 20 questions), and the result's note says so. " +
    "Costs credits (2 by default, +1 per 4 exercises beyond 8) and one daily generation. The first call returns the exact cost and a confirmation_token " +
    "without spending anything; ask the user in the conversation and call again with the same arguments plus confirmation_token ONLY after they explicitly approved (nothing to confirm when nothing is charged). " +
    "Generation then runs in the background for 10-20 minutes: track it with get_job_status.",
  kind: "generate",
  input: z.object({
    course: courseArg,
    chapter: z.union([z.number().int().positive(), z.string().min(1).max(160)]).optional()
      .describe("Chapter of the course plan to emphasise: its number (3) or title. See get_study_plan for the chapters."),
    focus: z.string().min(1).max(FIELD_LIMITS.focus).optional().describe("Free emphasis, e.g. \"eigenvalues and diagonalisation\"."),
    format: z.enum(["written", "mcq"]).optional()
      .describe("written = exercises like the course's real exams; mcq = multiple-choice questions. Default: the real exams' format; for a course without past exams, mcq if the focus asks for it, else written."),
    exercise_count: z.number().int().min(1).max(MCQ_MAX).optional()
      .describe(`Exercises (written, 1-${WRITTEN_MAX}) or questions (mcq, 1-${MCQ_MAX}). Default: as in the real exams; without past exams, ${WRITTEN_DEFAULT} exercises or ${MCQ_DEFAULT} questions.`),
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
      const plan = planMockExam({ format: args.format, count: args.exercise_count, focus, hasPastExams: (await pastExamCount()) > 0 });
      if ("error" in plan) throw new ToolError("invalid_input", plan.error);
      const base = { course: courseRefOf(c), focus, format: plan.format, exercise_count: plan.count, note: plan.note, confirmation: null, declined: null, job: null };
      const track = (jobId: number) => ({ job_id: jobId, estimated_minutes: "10-20", track_with: `get_job_status with job_id=${jobId}` });

      // Un examen déjà en cours est réutilisé, comme dans l'app : rien à confirmer, rien de débité.
      const running = await activeJob(plan.jobType);
      if (running) return { ...base, status: "already_running" as const, job: track(running.id) };

      const what = plan.format === "mcq"
        ? `un examen blanc de ${plan.count} QCM`
        : `un examen blanc${plan.count ? ` de ${plan.count} exercices` : " au format des annales"}`;
      const decision = await ctx.confirm(
        {
          bucket: "gen",
          costCenti: costForJob(plan.jobType, plan.target),
          summary: `Générer ${what}${focus ? " avec l'accent demandé" : ""} — ${courseLabel(c)} (10-20 min).`,
        },
        { course: c.id, focus, format: plan.format, count: plan.count },
        args.confirmation_token,
      );
      const pending = pendingResult(decision, base);
      if (pending) return pending;

      const started = await startGenerationJob(plan.jobType, plan.target);
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
