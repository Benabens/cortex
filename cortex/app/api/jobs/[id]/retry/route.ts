import { apiError } from "@/lib/i18n/api-error";
import { jobSpec, launchGate } from "@/lib/billing/limits";
import { ReservationRefused, costForJob, getJob, retryJob } from "@/lib/jobs";
import { requireCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Relance un job échoué/zombie : recrée un job de même type+target et redémarre le worker.
 * Un retry est une NOUVELLE génération → mêmes limites d'usage que les routes
 * generate, au coût exact du job relancé (lib/billing/limits). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  const { id } = await params;
  const old = await getJob(Number(id));
  if (old && old.type !== "ingest") {
    const gate = await launchGate(jobSpec(old.type, costForJob(old.type, old.target)));
    if (gate) return apiError(req, gate, gate.status);
  }
  let job;
  try {
    job = await retryJob(Number(id), course);
  } catch (e) {
    if (e instanceof ReservationRefused) return apiError(req, e, e.status);
    throw e;
  }
  if (!job) return apiError(req, "job_not_found", 404);
  return NextResponse.json({ ok: true, jobId: job.id, job });
}
