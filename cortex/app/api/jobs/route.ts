import { requestLocale } from "@/lib/i18n/api-error";
import { localizeJob } from "@/lib/i18n/job-text";
import { activeJob, listJobs, pumpQueuedJobs, type Job } from "@/lib/jobs";
import { useCourseOr404 } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const type = req.nextUrl.searchParams.get("type") as "exam" | "exercise" | null;
  void pumpQueuedJobs().catch(() => {}); // relance les jobs re-mis en file (fire-and-forget)
  // Étape et erreur dans la langue du lecteur (lib/i18n/job-text) ; le temps restant est sur /api/jobs/[id].
  const locale = requestLocale(req);
  const view = (j: Job) => {
    const { currentStep, error } = localizeJob(j, null, locale);
    return { ...j, currentStep, error };
  };
  const active = await activeJob(type ?? undefined);
  return NextResponse.json({ active: active ? view(active) : active, recent: (await listJobs(8)).map(view) });
}
