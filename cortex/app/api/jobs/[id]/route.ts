import { apiError } from "@/lib/i18n/api-error";
import { cancelJob, getJob, jobEta } from "@/lib/jobs";
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
  return NextResponse.json({
    ...job,
    error: job.error ? redactMessage(job.error) : job.error,
    currentStep: job.currentStep ? redactMessage(job.currentStep) : job.currentStep,
    eta: eta?.label ?? null,
  });
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
