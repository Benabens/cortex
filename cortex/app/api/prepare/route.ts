import { startPrepareJob } from "@/lib/generation";
import { requireCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ONBOARDING/préparation d'un cours DEPUIS L'UI (plus seulement en CLI). POST → job 'prepare'
 * (ingestion contenu+annales → détection du format → blueprint), avec progression suivie par l'UI.
 * Séquence partagée avec l'outil MCP prepare_course : lib/generation startPrepareJob.
 */
export async function POST(req: NextRequest) {
  const { denied } = requireCourse(req);
  if (denied) return denied;
  const started = await startPrepareJob();
  if (!started.ok) return NextResponse.json({ error: started.error }, { status: started.status });
  return NextResponse.json(started.existing ? { ok: true, jobId: started.jobId, existing: true } : { ok: true, jobId: started.jobId });
}
