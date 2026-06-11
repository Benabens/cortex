import { generateExam } from "@/lib/exam";
import { activeJob, createJob, startWorker } from "@/lib/jobs";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Génération d'examen : crée un JOB en arrière-plan et retourne immédiatement {jobId}.
 * Le worker détaché (scripts/run-job.ts) fait le travail (lots + vérif + compile) et survit
 * à la requête / au reload. L'UI poll /api/jobs/:id. (dry-run = stub local synchrone.)
 */
export async function POST(req: NextRequest) {
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  if (dry) {
    try {
      const res = await generateExam({ dry: true });
      return NextResponse.json({ ok: true, ...res });
    } catch (e: any) {
      return NextResponse.json({ error: String(e?.message ?? e) }, { status: 502 });
    }
  }

  const existing = activeJob("exam");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true });

  const jobId = createJob("exam");
  try {
    startWorker(jobId);
  } catch (e: any) {
    return NextResponse.json({ error: `Impossible de lancer le worker : ${e?.message ?? e}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, jobId });
}
