import * as z from "zod/v4";
import { q } from "@/db/q";
import { REPORT_REASONS, ReportError, reportQuestion } from "@/lib/question-reports";
import { courseArg, courseRef, courseRefOf } from "../schemas";
import { ToolError, defineTool } from "../tool";

const output = z.object({
  course: courseRef,
  report_id: z.number(),
  status: z.enum(["open", "confirmed", "not_confirmed"]).describe("confirmed / not_confirmed: verdict of the automatic re-check of a reported wrong answer against the course material; open: kept for review."),
  refunded_credits: z.number().describe("Credits given back for this question (a confirmed wrong answer)."),
  removed_from_revision: z.boolean(),
});

export default defineTool({
  name: "report_question",
  title: "Report a problem with a generated question",
  description:
    "Report one question of a mock exam Cortex generated: wrong_answer, off_course (not in the syllabus, or a definition that differs from the course), duplicate, or ambiguous. " +
    "Identify it by exam_id and the question number shown by get_job_status (multiple-choice questions first, then open ones). Free. " +
    "The question leaves the student's revisions and becomes a counter-example for the course's next exams; a reported wrong answer is re-checked against the course material and refunded when confirmed. " +
    "Use it to pass on a careful review of an exam, one call per faulty question, with the reason in comment.",
  kind: "write",
  input: z.object({
    course: courseArg,
    exam_id: z.number().int().positive(),
    question_number: z.number().int().positive().describe("Number of the question as shown by get_job_status."),
    reason: z.enum(REPORT_REASONS),
    comment: z.string().max(1000).optional().describe("What is wrong, ideally with what the course says."),
  }),
  output,
  async run(args, ctx) {
    return ctx.inCourse(args.course, async (c) => {
      // Même numérotation que get_job_status : QCM par rang, puis questions ouvertes / exercices ;
      // examen à questions composées : ses sous-questions dans l'ordre.
      const qcm = await q.all<{ id: number }>(`SELECT id FROM qcm_items WHERE exam_id = ? ORDER BY idx`, args.exam_id).catch(() => []);
      const open = await q.all<{ id: number }>(`SELECT id FROM exam_questions WHERE exam_id = ? ORDER BY id`, args.exam_id).catch(() => []);
      const parts = qcm.length || open.length ? [] : await q.all<{ id: number }>(
        `SELECT p.id FROM block_parts p JOIN exam_blocks b ON b.id = p.block_id WHERE p.exam_id = ? ORDER BY b.idx, p.idx`, args.exam_id,
      ).catch(() => []);
      const n = args.question_number;
      const target = parts.length
        ? (n <= parts.length ? { kind: "part" as const, itemId: Number(parts[n - 1].id) } : null)
        : n <= qcm.length
          ? { kind: "qcm" as const, itemId: Number(qcm[n - 1].id) }
          : n - qcm.length <= open.length ? { kind: "open" as const, itemId: Number(open[n - qcm.length - 1].id) } : null;
      if (!target) throw new ToolError("not_found", `L'examen n° ${args.exam_id} n'a pas de question ${n} dans ce cours.`);
      try {
        const r = await reportQuestion({ examId: args.exam_id, ...target, reason: args.reason, comment: args.comment ?? null });
        return { course: courseRefOf(c), report_id: r.id, status: r.status, refunded_credits: r.refundedCenti / 100, removed_from_revision: r.removedFromRevision > 0 };
      } catch (e) {
        if (e instanceof ReportError) throw new ToolError(e.status === 404 ? "not_found" : "invalid_input", e.message);
        throw e;
      }
    });
  },
  summarize: (o) => `Signalement n° ${o.report_id} enregistré${o.status === "confirmed" ? " : erreur confirmée" : o.status === "not_confirmed" ? " : la re-vérification ne trouve pas d'erreur" : ""}${o.refunded_credits ? `, ${o.refunded_credits} crédit rendu` : ""}.`,
});
