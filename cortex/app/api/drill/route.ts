import { apiError } from "@/lib/i18n/api-error";
import { useCourseOr404 } from "@/lib/req";
import { logLoopRoute } from "@/lib/req-log";
import { q } from "@/db/q";
import { dueConcepts } from "@/lib/schedule";
import { NextRequest, NextResponse } from "next/server";
import { readJson, withBodyLimit } from "@/lib/upload-limit";
import { fieldTooLong } from "@/lib/field-limits";
import { ReservationRefused } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const weaknesses = (await q.all<{ topic: string }>(`SELECT topic FROM weaknesses ORDER BY severity DESC LIMIT 12`))
    .map((w) => w.topic)
    .filter((t) => t && t !== "(à analyser)"); // i18n-allow: sentinelle stockée en base
  return NextResponse.json({ due: await dueConcepts(15), weaknesses });
}

/**
 * Lance l'exercice ciblé EN JOB (24/11/2026) : la requête rend la main tout de suite avec `jobId`,
 * le worker l'écrit (lib/drill-job), la page suit le job et lit l'exercice sur /api/jobs/[id].
 * Avant, la requête attendait le modèle une à trois minutes : quitter la page ou recharger perdait
 * l'exercice (déjà payé). Prix d'une aide réservé au lancement ; un refus revient tout de suite.
 */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const t0 = Date.now();
  const denied = useCourseOr404(req);
  if (denied) return denied;
  try {
    const { concept } = await readJson(req, ({ concept: "" }));
    const c = String(concept ?? "").trim();
    if (!c) return apiError(req, "concept_missing", 400);
    const tooLong = fieldTooLong(req, "concept", c);
    if (tooLong) return tooLong;
    try {
      const { startDrillJob } = await import("@/lib/drill-job");
      const { jobId, existing } = await startDrillJob(c, { fromWeb: true });
      return NextResponse.json({ ok: true, jobId, existing });
    } catch (e: unknown) {
      const { AssistRefused } = await import("@/lib/billing/reserve");
      if (e instanceof AssistRefused) return apiError(req, e, e.status);
      if (e instanceof ReservationRefused) return apiError(req, e, e.status);
      throw e;
    }
  } finally {
    logLoopRoute(req, "drill", t0);
  }
})
