import { requestLocale } from "@/lib/i18n/api-error";
import { localizeJob } from "@/lib/i18n/job-text";
import { activeJob, ASSIST_JOB_TYPES, isJobType, listJobs, listWebAssistJobs, pumpQueuedJobs, type Job } from "@/lib/jobs";
import { useCourseOr404 } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const raw = req.nextUrl.searchParams.get("type");
  // Type inconnu : aucun job de ce type ne peut être actif (jamais « le dernier job, quel qu'il soit »).
  const type = raw === null ? undefined : isJobType(raw) ? raw : null;
  void pumpQueuedJobs().catch(() => {}); // relance les jobs re-mis en file (fire-and-forget)
  // Étape et erreur dans la langue du lecteur (lib/i18n/job-text) ; le temps restant est sur /api/jobs/[id].
  const locale = requestLocale(req);
  const view = (j: Job) => {
    const { currentStep, error } = localizeJob(j, null, locale);
    return { ...j, currentStep, error };
  };
  const active = type === null ? null : await activeJob(type);
  // `assists=web` : les aides de l'app (exercice ciblé, correction), en cours ou finies depuis peu ;
  // la page qui les a lancées les retrouve au retour, même finies pendant l'absence.
  const assists = req.nextUrl.searchParams.get("assists") === "web" && type && ASSIST_JOB_TYPES.includes(type)
    ? (await listWebAssistJobs(type)).map((j) => ({ id: j.id, type: j.type, target: j.target, status: j.status }))
    : undefined;
  return NextResponse.json({ active: active ? view(active) : active, recent: (await listJobs(8)).map(view), ...(assists ? { assists } : {}) });
}
