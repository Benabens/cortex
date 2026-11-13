import * as z from "zod/v4";
import { billingEnabled, creditCost, fromCenti, purchasedBalanceCenti, subscriptionCreditsCenti } from "@/lib/billing/credits";
import { dailyLimit, usedToday } from "@/lib/billing/guards";
import { isOwner } from "@/lib/billing/owner";
import { costForJob } from "@/lib/jobs";
import { defineTool } from "../tool";

const quota = z.object({ used: z.number(), limit: z.number().nullable().describe("null = no daily limit on this instance.") });

const output = z.object({
  billing_enabled: z.boolean(),
  owner_mode: z.boolean().describe("true = owner of this Cortex instance: nothing is charged or counted, credits and daily limits do not apply."),
  credits: z.object({
    balance: z.number().describe("Total credits available now (purchased + this month's subscription credits)."),
    purchased: z.number(),
    subscription_this_month: z.number(),
  }).nullable(),
  costs: z.object({
    mock_exam: z.number().describe("Credits for a standard mock exam (up to 8 exercises; +1 per 4 more)."),
    drill: z.number(),
    check_answer: z.number(),
  }),
  // `costs` reste tel quel : publié en objet fermé (additionalProperties: false), un champ de plus
  // y casserait un client qui a gardé le schéma en cache (#52). Seule la racine tolère un ajout :
  // le détail par type vit donc ici, lui-même ouvert aux types à venir.
  costs_by_type: z.object({
    mock_exam: z.number().describe("Written-exercise mock exam, standard size."),
    mcq_exam: z.number().describe("Multiple-choice (QCM) mock exam, standard size: 20 questions + 3 open ones; a longer one costs more."),
    exercise: z.number().describe("A single generated exercise."),
    prepare_course: z.number().describe("Preparing a course (ingestion, exam format, plan)."),
    exam_format: z.number().describe("Re-detecting the exam format after adding past exams."),
    drill: z.number(),
    check_answer: z.number(),
  }).loose().describe("Credits per kind of generation, as charged on this instance (owner: nothing is charged)."),
  quotas: z.object({ generations: quota, assistance: quota }),
  app_link: z.string(),
});

export default defineTool({
  name: "get_account_status",
  title: "Get my credits and limits",
  description:
    "Get the student's credit balance, what each kind of generation costs (written or multiple-choice mock exam, exercise, course preparation, " +
    "format detection, drill, answer check), and today's usage against the daily limits " +
    "(mock exams count as generations; drills and answer checks count as assistance). " +
    "Use it before suggesting paid actions or when the student asks how many credits they have left. Read-only and free.",
  kind: "read",
  input: z.object({}),
  output,
  async run(_args, ctx) {
    const on = billingEnabled();
    const owner = await isOwner(ctx.principal.userId);
    const purchased = on ? await purchasedBalanceCenti() : 0;
    const sub = on ? await subscriptionCreditsCenti() : 0;
    return {
      billing_enabled: on,
      owner_mode: owner,
      credits: on ? { balance: fromCenti(purchased + sub), purchased: fromCenti(purchased), subscription_this_month: fromCenti(sub) } : null,
      costs: { mock_exam: fromCenti(creditCost("exam")), drill: fromCenti(creditCost("assist")), check_answer: fromCenti(creditCost("assist")) },
      // Lus comme au débit (creditCost, donc CREDITS_COST_JSON ; costForJob pour la taille standard du QCM).
      costs_by_type: {
        mock_exam: fromCenti(costForJob("exam")),
        mcq_exam: fromCenti(costForJob("qcm")),
        exercise: fromCenti(costForJob("exercise")),
        prepare_course: fromCenti(costForJob("prepare")),
        exam_format: fromCenti(costForJob("format")),
        drill: fromCenti(creditCost("assist")),
        check_answer: fromCenti(creditCost("assist")),
      },
      quotas: {
        generations: { used: await usedToday("gen"), limit: await dailyLimit("gen") },
        assistance: { used: await usedToday("assist"), limit: await dailyLimit("assist") },
      },
      app_link: `${ctx.appOrigin}/compte`,
    };
  },
  summarize: (o) => (o.owner_mode
    ? "Compte propriétaire : rien n'est débité ni compté. "
    : o.credits
    ? `Solde : ${o.credits.balance} crédit(s). `
    : "Facturation désactivée sur cette instance. ") +
    `Aujourd'hui : ${o.quotas.generations.used}${o.quotas.generations.limit === null ? "" : `/${o.quotas.generations.limit}`} génération(s), ` +
    `${o.quotas.assistance.used}${o.quotas.assistance.limit === null ? "" : `/${o.quotas.assistance.limit}`} assistance(s).`,
});
