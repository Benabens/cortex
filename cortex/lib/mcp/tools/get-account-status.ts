import * as z from "zod/v4";
import { billingEnabled, creditCost, fromCenti, purchasedBalanceCenti, subscriptionCreditsCenti } from "@/lib/billing/credits";
import { dailyLimit, usedToday } from "@/lib/billing/guards";
import { getUsageLimits } from "@/lib/billing/limits";
import { remainingLine } from "@/lib/billing/limits-text";
import { isOwner } from "@/lib/billing/owner";
import { costForJob } from "@/lib/jobs";
import { defineTool, READ_ONLY_HINTS } from "../tool";

const quota = z.object({ used: z.number(), limit: z.number().nullable().describe("null = no daily limit on this instance.") });

const generationLeft = z.object({
  remaining: z.number().nullable().describe("How many more of this kind can be launched, under the most constraining limit; null = no limit."),
  limited_by: z.string().nullable().describe("Which limit sets that number (credits, daily_generations, daily_assistance, daily_compute, monthly_capacity, free_budget, free_capacity, storage)."),
  resets_at: z.string().nullable().describe("When that limit resets (ISO 8601, UTC); null for credits (they come back by buying or with the subscription)."),
  can_launch_now: z.boolean(),
  blocked_reason: z.string().nullable().describe("When can_launch_now is false: the exact message the app and the generation tools return. Tell it to the student as is."),
  cost_credits: z.number(),
  summary: z.string().nullable().describe("One line for the student, e.g. \"Il te reste 3 examens QCM aujourd'hui · remise à 0 demain à 01:00\"."),
});

// Même fonction que la page « Mon usage » de l'app et que les refus des outils payants
// (lib/billing/limits) : un chiffre affiché ici est celui qu'une génération rencontrera.
const usageLimits = z.object({
  generations: z.object({
    mock_exam: generationLeft.describe("Written mock exam, standard size."),
    mcq_exam: generationLeft.describe("Multiple-choice mock exam, 20 questions + 3 open ones."),
    exercise: generationLeft,
    prepare_course: generationLeft,
    check_answer: generationLeft,
    drill: generationLeft,
  }).loose(),
  limits: z.array(z.object({
    key: z.string(),
    label: z.string(),
    used: z.number().nullable(),
    limit: z.number().nullable(),
    remaining: z.number().nullable(),
    unit: z.string().describe("credits, generations, %, MB… Spending caps are given as a percentage, never as an amount of money."),
    resets_at: z.string().nullable(),
  })),
}).loose();

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
  usage_limits: usageLimits.describe("Every limit that can stop a generation, and how many of each kind can still be launched. Check it before suggesting a paid action."),
  app_link: z.string(),
});

export default defineTool({
  name: "get_account_status",
  title: "Get my credits and limits",
  description:
    "Get the student's credit balance, what each kind of generation costs (written or multiple-choice mock exam, exercise, course preparation, " +
    "format detection, drill, answer check), and today's usage against the daily limits " +
    "(mock exams count as generations; drills and answer checks count as assistance). " +
    "usage_limits gives every limit that can stop a generation (credits, daily quotas, daily compute, monthly capacity, storage) with its reset time, " +
    "and how many of each kind the student can still launch — the same numbers the app shows and the paid tools enforce. " +
    "Use it before suggesting paid actions or when the student asks how many credits or generations they have left. Read-only and free.",
  kind: "read",
  annotations: READ_ONLY_HINTS,
  userSummary: "Lit ton solde de crédits, les coûts et tes limites du jour.",
  input: z.object({}),
  output,
  async run(_args, ctx) {
    const on = billingEnabled();
    const owner = await isOwner(ctx.principal.userId);
    const purchased = on ? await purchasedBalanceCenti() : 0;
    const sub = on ? await subscriptionCreditsCenti() : 0;
    const usage = await getUsageLimits(ctx.principal.userId);
    const left = (k: keyof typeof usage.generations) => {
      const g = usage.generations[k];
      return {
        remaining: g.remaining, limited_by: g.limitedBy, resets_at: g.resetAt, can_launch_now: g.allowed,
        blocked_reason: g.reason, cost_credits: g.costCredits, summary: remainingLine(g, usage.now),
      };
    };
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
      usage_limits: {
        generations: {
          mock_exam: left("exam"), mcq_exam: left("qcm"), exercise: left("exercise"),
          prepare_course: left("prepare"), check_answer: left("check"), drill: left("drill"),
        },
        limits: usage.limits.map((l) => ({ key: l.key, label: l.label, used: l.used, limit: l.limit, remaining: l.remaining, unit: l.unit, resets_at: l.resetAt })),
      },
      app_link: `${ctx.appOrigin}/compte#usage`,
    };
  },
  summarize: (o) => (o.owner_mode
    ? "Compte propriétaire : rien n'est débité ni compté. "
    : o.credits
    ? `Solde : ${o.credits.balance} crédit(s). `
    : "Facturation désactivée sur cette instance. ") +
    `Aujourd'hui : ${o.quotas.generations.used}${o.quotas.generations.limit === null ? "" : `/${o.quotas.generations.limit}`} génération(s), ` +
    `${o.quotas.assistance.used}${o.quotas.assistance.limit === null ? "" : `/${o.quotas.assistance.limit}`} assistance(s).` +
    (o.usage_limits.generations.mcq_exam.summary ? ` ${o.usage_limits.generations.mcq_exam.summary}.` : ""),
});
