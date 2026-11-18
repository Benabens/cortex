import { apiError } from "@/lib/i18n/api-error";
import { jobSpec, launchGate } from "@/lib/billing/limits";
import { fromCenti } from "@/lib/billing/credits";
import { ReservationRefused, activeJob, costForJob, createJobExclusive, startWorker } from "@/lib/jobs";
import { requireCourse, useCourseOr404 } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Détection du format en cours (reprise au reload). */
export async function GET(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  return NextResponse.json({ active: await activeJob("format") });
}

/**
 * RELIRE LE FORMAT sur les annales déposées (job « format » : vision LLM → un crédit et une
 * génération du jour). Lancé par l'étudiant, jamais par le dépôt lui-même (POST /api/refs/upload,
 * gratuit) : l'écran affiche le coût avant le clic (GET /api/usage?kind=format), la réponse dit ce
 * qui a été débité (`chargedCredits` : 0 pour une détection déjà en cours, réutilisée).
 */
export async function POST(req: NextRequest) {
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  const existing = await activeJob("format");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true, chargedCredits: 0 });
  if (process.env.E2E_TEST_AUTH === "1" && process.env.E2E_TEST_RUN === "1") {
    // i18n-allow: drapeau des E2E hermétiques, jamais affiché
    return NextResponse.json({ ok: true, skipped: "Détection couverte par la préparation hermétique E2E", chargedCredits: 0 });
  }

  const gate = await launchGate(jobSpec("format", costForJob("format")));
  if (gate) return apiError(req, gate, gate.status);
  let created: Awaited<ReturnType<typeof createJobExclusive>>;
  try {
    created = await createJobExclusive("format", JSON.stringify({ reason: "upload" }));
  } catch (e) {
    if (e instanceof ReservationRefused) return apiError(req, e, e.status);
    throw e;
  }
  if (!created.existing) {
    try {
      await startWorker(created.id, course);
    } catch {
      return apiError(req, "format_detection_start_failed", 500);
    }
  }
  return NextResponse.json({ ok: true, jobId: created.id, existing: created.existing, chargedCredits: fromCenti(created.costCenti) });
}
