import * as z from "zod/v4";
import { q } from "@/db/q";
import { creditCost } from "@/lib/billing/credits";
import { generateDrill } from "@/lib/drill";
import { FIELD_LIMITS } from "@/lib/field-limits";
import { dueConcepts } from "@/lib/schedule";
import { runAssist } from "../assist";
import { clip, htmlToText } from "../content";
import { courseLabel } from "../courses";
import { confirmationTokenArg, courseArg, courseRef, courseRefOf, declinedSchema, declinedSummary, generationStatus, quoteSchema, quoteSummary } from "../schemas";
import { ToolError, defineTool } from "../tool";

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
    const w = await q.get<{ topic: string }>(
      `SELECT topic FROM weaknesses WHERE topic IS NOT NULL AND topic != '(à analyser)' ORDER BY severity DESC, logged_at DESC LIMIT 1`,
    );
    if (w?.topic) return w.topic;
  } catch { /* pas encore de table des faiblesses */ }
  try { return (await dueConcepts(1))[0] ?? null; } catch { return null; }
}

export default defineTool({
  name: "generate_drill",
  title: "Generate a practice question",
  description:
    "Generate ONE exam-style practice question on a concept, with five progressive hints and a worked solution, in the style of the course's real exams. " +
    "Without a concept it targets the student's most serious weak point. Costs credits (0.1 by default) and one daily assistance: " +
    "the first call returns the exact cost and a confirmation_token without spending anything (or asks the user directly if the client supports it); " +
    "call again with the same arguments plus confirmation_token ONLY after the user explicitly approved. Takes up to a few minutes.",
  kind: "generate",
  input: z.object({
    course: courseArg,
    concept: z.string().min(1).max(FIELD_LIMITS.concept).optional().describe("Concept to practise, e.g. \"diagonalisation\". Defaults to the most serious weak point."),
    confirmation_token: confirmationTokenArg,
  }),
  output,
  async run(args, ctx) {
    return ctx.inCourse(args.course, async (c) => {
      const concept = args.concept?.trim() || (await defaultConcept());
      if (!concept) throw new ToolError("invalid_input", "Aucun point faible ni concept à revoir sur ce cours : précise le concept à travailler (concept).");
      const base = { course: courseRefOf(c), concept: clip(concept, FIELD_LIMITS.concept), confirmation: null, declined: null, drill: null };
      const decision = await ctx.confirm(
        { bucket: "assist", costCenti: creditCost("assist"), summary: `Générer une question d'entraînement (5 indices + corrigé) sur « ${clip(concept, 80)} » — ${courseLabel(c)}.` },
        { course: c.id, concept },
        args.confirmation_token,
      );
      if (decision.kind === "input_required") return decision.result;
      if (decision.kind === "quote") return { ...base, status: "confirmation_required" as const, confirmation: decision.quote };
      if (decision.kind === "declined") return { ...base, status: "declined" as const, declined: decision.declined };
      await ctx.progress("Rédaction de la question…");
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
    return "Question d'entraînement prête : propose les indices un par un avant de montrer le corrigé.";
  },
});
