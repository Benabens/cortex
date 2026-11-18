import * as z from "zod/v4";
import type { CourseConfig } from "@/lib/courses";
import { courseLabel } from "./courses";
import { QUOTA_LABEL, type DeclinedView, type QuoteView } from "./tool";
import { ANSWER_MODES, DOCUMENT_RULES, EXAM_KINDS, LANGUAGES, type ExamFormat } from "@/lib/exam-format";

/** Pièces de schéma partagées par les outils (entrées et sorties). */

export const courseArg = z.string().min(1).max(120).optional()
  .describe("Course to use: its code (e.g. \"COMP 201\"), its name, or its id from list_courses. Optional when the account has a single course.");

export const confirmationTokenArg = z.string().min(10).max(200).optional()
  .describe("The confirmation_token returned by the previous call with the same arguments; with it, the call runs and spends the quoted cost.");

export const courseRef = z.object({ id: z.string(), label: z.string() });
export function courseRefOf(c: CourseConfig): z.infer<typeof courseRef> {
  return { id: c.id, label: courseLabel(c) };
}

export const quoteSchema = z.object({
  cost: z.object({ credits: z.number(), centi: z.number() }),
  balance: z.object({ credits: z.number() }).nullable(),
  remaining: z.number().optional().describe("How many launches of this kind remain after this one, when a limit applies."),
  resetAt: z.string().optional().describe("When the limiting quota resets, as an ISO timestamp."),
  cost_credits: z.number().nullable().describe("Exact cost in credits (null when billing is disabled on this instance)."),
  balance_credits: z.number().nullable(),
  balance_after_credits: z.number().nullable(),
  daily_quota: z.object({ kind: z.enum(["generations", "assistance"]), used: z.number(), limit: z.number().nullable() }),
  summary: z.string(),
  confirmation_token: z.string(),
  expires_in_seconds: z.number(),
  how_to_confirm: z.string(),
});

export const declinedSchema = z.object({
  cost: z.object({ credits: z.number(), centi: z.number() }),
  balance: z.object({ credits: z.number() }).nullable(),
  remaining: z.number().optional().describe("How many launches of this kind would have remained after the declined action."),
  resetAt: z.string().optional().describe("When the limiting quota resets, as an ISO timestamp."),
  action: z.enum(["decline", "cancel"]).describe("decline = the user refused; cancel = the confirmation was dismissed or could not be shown by this client."),
  cost_credits: z.number().nullable(),
  summary: z.string(),
});

/** Voix du serveur : uniquement le coût et la nature du refus (l'objet de l'action reste dans les données). */
export function declinedSummary(d: DeclinedView): string {
  const cost = d.cost_credits === null ? "" : ` (quoted cost: ${d.cost_credits} credits)`;
  return d.action === "decline"
    ? `The student declined the charge${cost}. Nothing was charged or generated.`
    : `The confirmation${cost} did not complete: it was dismissed without an answer or could not be shown by this client in a non-interactive session. ` +
      "Nothing was charged. The student must confirm a paid action in an interactive session.";
}

/** Statut commun d'un outil de génération. */
export const generationStatus = z.enum(["confirmation_required", "declined", "done", "started", "already_running"]);

/**
 * Résumé (voix du serveur) d'un devis : uniquement des nombres — l'objet de
 * l'action peut citer un sujet tiré des documents du cours, il reste dans le bloc de données.
 */
export function quoteSummary(q: QuoteView): string {
  const fmt = (credits: number | null) => String(credits ?? 0);
  const cost = q.cost_credits === null ? "0 credits (billing disabled)" : `${fmt(q.cost_credits)} credits`;
  const balance = q.balance_credits === null ? "" : ` (balance ${fmt(q.balance_credits)} → ${fmt(q.balance_after_credits)})`;
  const quota = q.daily_quota.limit === null ? "" : `, ${QUOTA_LABEL[q.daily_quota.kind]} today ${q.daily_quota.used}/${q.daily_quota.limit}`;
  return `Confirmation is required before any charge: ${cost}${balance}${quota}. Nothing was charged. ` +
    `Show this cost to the student. Only if the student agrees, call the tool again with the same arguments and confirmation_token, valid for ${Math.round(q.expires_in_seconds / 60)} minutes.`;
}

/** Format d'examen d'un cours tel que le moteur le comprend (lib/exam-format). */
export const examFormatSchema = z.object({
  kind: z.enum(EXAM_KINDS).nullable().describe("qcm, exercises, mixed (QCM + open questions), essay, oral — null when unknown."),
  basis: z.enum(["annales", "declared", "sample_questions", "course_info", "unknown"])
    .describe("Where the format comes from, most reliable first: past exams, declared by the student, official sample questions, course information, or unknown."),
  question_count: z.number().nullable(),
  duration_min: z.number().nullable(),
  language: z.string().describe("Language of the generated exam."),
  summary: z.string(),
});

export function examFormatOf(f: ExamFormat): z.infer<typeof examFormatSchema> {
  const kind = f.kind === "qcm" ? "multiple choice"
    : f.kind === "exercises" ? "written exercises"
    : f.kind === "mixed" ? "multiple-choice and open questions"
    : f.kind === "composite" ? "composite questions"
    : f.kind === "essay" ? "essay"
    : f.kind === "oral" ? "oral exam"
    : "unknown format";
  const basis = f.basis === "annales" ? "from past exams"
    : f.basis === "declared" ? "declared by the student"
    : f.basis === "sample_questions" ? "from official sample questions"
    : f.basis === "course_info" ? "from course information"
    : "source unknown";
  const details = [
    f.questionCount ? `${f.questionCount} question${f.questionCount === 1 ? "" : "s"}` : null,
    f.durationMin ? `${f.durationMin} minutes` : null,
    f.answerMode === "single" ? "one correct answer per question"
      : f.answerMode === "multiple" ? "multiple correct answers"
      : f.answerMode === "mixed" ? "single- and multiple-answer questions" : null,
    f.documents === "none" ? "no documents allowed"
      : f.documents === "notes" ? "personal notes allowed"
      : f.documents === "open" ? "documents allowed" : null,
  ].filter(Boolean);
  const summary = `${kind}${details.length ? `, ${details.join(", ")}` : ""} (${basis}, language: ${f.language})`;
  return { kind: f.kind, basis: f.basis, question_count: f.questionCount, duration_min: f.durationMin, language: f.language, summary };
}

/** Entrée d'un format déclaré (create_course, set_exam_format). */
export const examFormatInput = {
  kind: z.enum(EXAM_KINDS).describe("Exam type: qcm (multiple choice), exercises (problems to solve), mixed (multiple choice + open questions), composite (each question = a short scenario or code excerpt followed by sub-questions mixing single choice, code reading and short answers), essay, oral."),
  question_count: z.number().int().min(1).max(200).optional().describe("Number of questions (qcm, composite) or of exercises / essay topics."),
  duration_min: z.number().int().min(5).max(600).optional().describe("Exam duration in minutes."),
  language: z.enum(LANGUAGES).optional().describe("Language of the exam, when it differs from the course language."),
  answer_mode: z.enum(ANSWER_MODES).optional().describe("Multiple-choice exams: single (exactly one correct answer per question, the default when nothing says otherwise), multiple (one or more correct answers), or mixed. Past exams, when present, decide instead."),
  documents: z.enum(DOCUMENT_RULES).optional().describe("Documents allowed during the exam: none, notes (personal notes / cheat sheet) or open (everything). Printed on the cover of the mock exam; omit when unknown."),
};
