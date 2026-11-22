import * as z from "zod/v4";
import { creditCost } from "@/lib/billing/credits";
import { checkSolution } from "@/lib/check-solution";
import { FIELD_LIMITS } from "@/lib/field-limits";
import { runAssist } from "../assist";
import { clip } from "../content";
import { courseLabel } from "../courses";
import { confirmationTokenArg, courseArg, courseRef, courseRefOf, declinedSchema, declinedSummary, generationStatus, quoteSchema, quoteSummary } from "../schemas";
import { defineTool, pendingResult, SPENDING_HINTS, paidCall } from "../tool";

const output = z.object({
  status: generationStatus,
  course: courseRef,
  confirmation: quoteSchema.nullable(),
  declined: declinedSchema.nullable().describe("When status is declined: why, and the cost that was announced."),
  result: z.object({
    verdict: z.enum(["correct", "partial", "wrong"]),
    score: z.object({ earned: z.number(), total: z.number() }),
    feedback: z.string(),
    criteria: z.array(z.object({
      label: z.string(), points: z.number(), achieved: z.boolean(), essential: z.boolean(), justification: z.string(),
    })).describe("Grading rubric applied criterion by criterion."),
    correct_solution: z.string(),
  }).nullable(),
});

export default defineTool({
  name: "check_answer",
  title: "Grade my answer",
  description:
    "Grades the student's answer to an exam question the way the course's examiner would: verdict, rubric criterion by criterion, score, feedback and a correct solution. " +
    "Input: the exact question and the student's answer. " +
    paidCall("assistance"),
  kind: "generate",
  annotations: SPENDING_HINTS,
  userSummary: "checkAnswer",
  input: z.object({
    course: courseArg,
    // trim() AVANT min(1) : une réponse faite d'espaces était acceptée, corrigée sans réponse et débitée.
    statement: z.string().trim().min(1).max(FIELD_LIMITS.statement).describe("The exact question / exercise statement."),
    answer: z.string().trim().min(1).max(FIELD_LIMITS.answer).describe("The student's answer, as written."),
    confirmation_token: confirmationTokenArg,
  }),
  output,
  async run(args, ctx) {
    return ctx.inCourse(args.course, async (c) => {
      const base = { course: courseRefOf(c), confirmation: null, declined: null, result: null };
      const statement = args.statement.trim();
      const answer = args.answer.trim();
      const decision = await ctx.confirm(
        { bucket: "assist", kind: "check", costCenti: creditCost("assist"), summary: `Grade an answer using ${courseLabel(c)}’s rubric.` },
        { course: c.id, statement, answer },
        args.confirmation_token,
      );
      const pending = pendingResult(decision, base);
      if (pending) return pending;
      await ctx.progress("Grading the answer…");
      const r = await runAssist("check-solution", () => checkSolution({ statement, answer, imageRel: null }));
      return {
        ...base,
        status: "done" as const,
        result: {
          verdict: r.verdict,
          score: r.score,
          feedback: clip(r.feedback, 4000),
          criteria: r.criteria.slice(0, 5).map((k) => ({ ...k, label: clip(k.label, 300), justification: clip(k.justification, 800) })),
          correct_solution: clip(r.correct_solution, 6000),
        },
      };
    });
  },
  summarize: (o) => {
    if (o.status === "confirmation_required" && o.confirmation) return quoteSummary(o.confirmation);
    if (o.status === "declined" && o.declined) return declinedSummary(o.declined);
    return o.result ? `Grading result: ${o.result.verdict}, ${o.result.score.earned}/${o.result.score.total}.` : "Grading complete.";
  },
});
