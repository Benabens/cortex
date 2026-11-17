import * as z from "zod/v4";
import { creditCost } from "@/lib/billing/credits";
import { generateDrill } from "@/lib/drill";
import { FIELD_LIMITS } from "@/lib/field-limits";
import { dueConcepts } from "@/lib/schedule";
import { topWeaknessTopic } from "@/lib/weaknesses";
import { runAssist } from "../assist";
import { clip, htmlToText } from "../content";
import { courseLabel } from "../courses";
import { confirmationTokenArg, courseArg, courseRef, courseRefOf, declinedSchema, declinedSummary, generationStatus, quoteSchema, quoteSummary } from "../schemas";
import { defineTool, pendingResult, SPENDING_HINTS, ToolError, paidCall } from "../tool";

const output = z.object({
  status: generationStatus,
  course: courseRef,
  concept: z.string(),
  confirmation: quoteSchema.nullable().describe("When status is confirmation_required: the exact cost and the token to confirm with."),
  declined: declinedSchema.nullable().describe("When status is declined: why, and the cost that was announced."),
  drill: z.object({
    statement: z.string(),
    hints: z.array(z.string()).describe("Five hints, from vague to almost the solution: reveal them one at a time."),
    solution: z.string(),
  }).nullable(),
});

/** Concept par défaut : le point faible le plus grave, sinon le concept le plus en retard en répétition espacée. */
async function defaultConcept(): Promise<string | null> {
  try {
    const top = await topWeaknessTopic();
    if (top) return top;
  } catch { /* pas encore de table des faiblesses */ }
  try { return (await dueConcepts(1))[0] ?? null; } catch { return null; }
}

export default defineTool({
  name: "generate_drill",
  title: "Generate a practice question",
  description:
    "Generates ONE exam-style practice question on a concept, in the style of the course's real exams, with five progressive hints and a worked solution. " +
    "Without a concept, it targets the student's most serious weak point. Takes up to a few minutes. " +
    paidCall("assistance"),
  kind: "generate",
  annotations: SPENDING_HINTS,
  userSummary: "Génère une question d’entraînement, avec indices et corrigé.",
  input: z.object({
    course: courseArg,
    concept: z.string().min(1).max(FIELD_LIMITS.concept).optional().describe("Concept to practise, e.g. \"diagonalisation\". Defaults to the most serious weak point."),
    confirmation_token: confirmationTokenArg,
  }),
  output,
  async run(args, ctx) {
    return ctx.inCourse(args.course, async (c) => {
      const concept = args.concept?.trim() || (await defaultConcept());
      if (!concept) throw new ToolError("invalid_input", "This course has no tracked weak point or concept due for review. Specify the concept to practise with “concept”.");
      const base = { course: courseRefOf(c), concept: clip(concept, FIELD_LIMITS.concept), confirmation: null, declined: null, drill: null };
      const decision = await ctx.confirm(
        { bucket: "assist", kind: "drill", costCenti: creditCost("assist"), summary: `Generate one practice question with five hints and a worked solution on “${clip(concept, 80)}” for ${courseLabel(c)}.` },
        { course: c.id, concept },
        args.confirmation_token,
      );
      const pending = pendingResult(decision, base);
      if (pending) return pending;
      await ctx.progress("Writing the practice question…");
      const d = await runAssist("drill", () => generateDrill(concept));
      return {
        ...base,
        status: "done" as const,
        drill: {
          statement: clip(htmlToText(d.statement_html), 6000),
          hints: (d.hints ?? []).slice(0, 5).map((h) => clip(htmlToText(h), 1500)),
          solution: clip(htmlToText(d.solution_html), 8000),
        },
      };
    });
  },
  summarize: (o) => {
    if (o.status === "confirmation_required" && o.confirmation) return quoteSummary(o.confirmation);
    if (o.status === "declined" && o.declined) return declinedSummary(o.declined);
    return "The practice question is ready. Offer the hints one at a time before showing the worked solution.";
  },
});
