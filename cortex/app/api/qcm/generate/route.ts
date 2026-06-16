import { activeJob, createJob, startWorker } from "@/lib/jobs";
import { getFormatProfile } from "@/lib/format";
import { preflightGeneration } from "@/lib/preflight";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET : le profil de format détecté (pour l'UI). */
export function GET(req: NextRequest) {
  useCourse(req);
  return NextResponse.json({ format: getFormatProfile() });
}

/** POST {count?} : génère un mock QCM (job arrière-plan). */
export async function POST(req: NextRequest) {
  const course = useCourse(req);
  const fmt = getFormatProfile();
  if (!fmt?.has_mcq) return NextResponse.json({ error: "Format non détecté ou sans QCM pour ce cours. Lance la détection de format d'abord." }, { status: 400 });
  const existing = activeJob("qcm");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true });
  const issue = preflightGeneration();
  if (issue) return NextResponse.json({ error: issue.error, command: issue.command }, { status: issue.status });
  const { count } = await req.json().catch(() => ({}));
  const jobId = createJob("qcm", JSON.stringify({ count: count || undefined }));
  try { startWorker(jobId, course); }
  catch (e: any) { return NextResponse.json({ error: `worker : ${e?.message ?? e}` }, { status: 500 }); }
  return NextResponse.json({ ok: true, jobId });
}
