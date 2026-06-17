import { activeJob, createJob, startWorker } from "@/lib/jobs";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * V10 — ONBOARDING/préparation d'un cours DEPUIS L'UI (plus seulement en CLI). POST → job 'prepare'
 * (ingestion contenu+annales → détection du format → blueprint), avec progression suivie par l'UI.
 */
export async function POST(req: NextRequest) {
  const course = useCourse(req);
  const existing = activeJob("prepare");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true });
  const jobId = createJob("prepare");
  try { startWorker(jobId, course); }
  catch (e: any) { return NextResponse.json({ error: `worker : ${e?.message ?? e}` }, { status: 500 }); }
  return NextResponse.json({ ok: true, jobId });
}
