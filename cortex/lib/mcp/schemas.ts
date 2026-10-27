import * as z from "zod/v4";
import type { CourseConfig } from "@/lib/courses";
import { courseLabel } from "./courses";
import { fmtCredits, toCenti } from "@/lib/billing/credits";
import { QUOTA_LABEL, type DeclinedView, type QuoteView } from "./tool";

/** Pièces de schéma partagées par les outils (entrées et sorties). */

export const courseArg = z.string().min(1).max(120).optional()
  .describe("Course to use: its code (e.g. \"CS-233\"), its name, or its id from list_courses. Optional when the account has a single course.");

export const confirmationTokenArg = z.string().min(10).max(200).optional()
  .describe("Only after the user explicitly approved the quoted cost: the confirmation_token returned by the previous call with the same arguments.");

export const courseRef = z.object({ id: z.string(), label: z.string() });
export function courseRefOf(c: CourseConfig): z.infer<typeof courseRef> {
  return { id: c.id, label: courseLabel(c) };
}

export const quoteSchema = z.object({
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
  action: z.enum(["decline", "cancel"]).describe("decline = the user refused; cancel = the confirmation was dismissed or could not be shown by this client."),
  cost_credits: z.number().nullable(),
  summary: z.string(),
});

/** Voix du serveur : uniquement le coût et la nature du refus (l'objet de l'action reste dans les données). */
export function declinedSummary(d: DeclinedView): string {
  const cost = d.cost_credits === null ? "" : ` (coût annoncé : ${fmtCredits(toCenti(d.cost_credits))} crédit(s))`;
  return d.action === "decline"
    ? `La personne a refusé la dépense${cost} : rien n'a été débité, rien n'a été généré.`
    : `La confirmation${cost} n'a pas abouti : fermée sans réponse, ou impossible à afficher dans ce client (session non interactive). ` +
      "Rien n'a été débité. Une action payante doit être confirmée par la personne dans une session interactive.";
}

/** Statut commun d'un outil de génération. */
export const generationStatus = z.enum(["confirmation_required", "declined", "done", "started", "already_running"]);

/**
 * Résumé (voix du serveur) d'un devis : uniquement des nombres — l'objet de
 * l'action peut citer un sujet tiré des documents du cours, il reste dans le bloc de données.
 */
export function quoteSummary(q: QuoteView): string {
  const fmt = (credits: number | null) => fmtCredits(toCenti(credits ?? 0));
  const cost = q.cost_credits === null ? "sans crédit (facturation désactivée)" : `${fmt(q.cost_credits)} crédit(s)`;
  const balance = q.balance_credits === null ? "" : ` (solde ${fmt(q.balance_credits)} → ${fmt(q.balance_after_credits)})`;
  const quota = q.daily_quota.limit === null ? "" : `, ${QUOTA_LABEL[q.daily_quota.kind]} aujourd'hui ${q.daily_quota.used}/${q.daily_quota.limit}`;
  return `Confirmation requise avant toute dépense : ${cost}${balance}${quota}. Rien n'a été débité. ` +
    `Montre ce coût à la personne ; seulement si elle accepte, rappelle l'outil avec les mêmes arguments et confirmation_token (valable ${Math.round(q.expires_in_seconds / 60)} min).`;
}
