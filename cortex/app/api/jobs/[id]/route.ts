import { billingEnabled } from "@/lib/billing/credits";
import { isOwner } from "@/lib/billing/owner";
import { etaFields } from "@/lib/eta";
import { apiError, requestLocale } from "@/lib/i18n/api-error";
import { localizeJob } from "@/lib/i18n/job-text";
import { cancelJob, getJob, jobEta, type Job } from "@/lib/jobs";
import { mathInHtml } from "@/lib/math-html";
import { sanitizeHtml } from "@/lib/sanitize-html";
import { JOB_ACTIVE } from "@/lib/ux/job-status";
import { redactMessage } from "@/lib/observability";
import { useCourseOr404 } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const { id } = await params;
  const job = await getJob(Number(id));
  if (!job) return apiError(req, "job_not_found", 404);
  // Temps restant estimé (lib/eta) : affiché par le suivi, jamais bloquant.
  const eta = await jobEta(job).catch(() => null);
  // Même nettoyage que le connecteur MCP (lib/mcp/tools/get-job-status) : error ET
  // currentStep sont affichés tels quels par l'app (JobBanner, ExamComposer…), et une
  // cause brute (fournisseur, journal tectonic) peut citer un chemin ou un identifiant.
  // Étape, temps restant et erreur dans la langue du lecteur (lib/i18n/job-text).
  const redacted = {
    ...job,
    error: job.error ? redactMessage(job.error) : job.error,
    currentStep: job.currentStep ? redactMessage(job.currentStep) : job.currentStep,
  };
  // Le suivi dit ce qu'une annulation rend : sans facturation, ou pour le propriétaire, rien n'est
  // débité, on ne lui promet pas de crédits. Lu seulement tant que le job tourne (bouton Annuler).
  const charged = JOB_ACTIVE.includes(job.status) ? billingEnabled() && !(await isOwner()) : undefined;
  // La fourchette du temps restant (lib/eta) : la barre de suivi l'affiche, le libellé reste celui d'avant.
  return NextResponse.json({ ...redacted, ...localizeJob(redacted, eta, requestLocale(req)), ...etaFields(eta), charged, ...(await assistResult(job)) });
}

/** Aide en job terminée (exercice ciblé, correction) : son résultat, pour la page qui la suit. */
async function assistResult(job: Job) {
  if (job.status !== "done") return {};
  if (job.type === "drill") {
    const { drillOfJob } = await import("@/lib/drill-job");
    const drill = await drillOfJob(job);
    // HTML du modèle assaini ici, formules composées (lib/math-html) : la vue l'affiche par `SafeHtml math`.
    const withFormulas = (html: string) => mathInHtml(html) ?? sanitizeHtml(html);
    return drill ? { drill: { ...drill, statement_html: withFormulas(drill.statement_html), solution_html: withFormulas(drill.solution_html) } } : {};
  }
  if (job.type === "check") {
    const { checkOfJob } = await import("@/lib/check-job");
    const check = await checkOfJob(job);
    return check ? { check } : {};
  }
  return {};
}

/** Annulation (alias historique de /cancel) : tue réellement le worker et ses enfants. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const { id } = await params;
  const job = await cancelJob(Number(id));
  if (!job) return apiError(req, "job_not_found", 404);
  return NextResponse.json({ ok: true });
}
