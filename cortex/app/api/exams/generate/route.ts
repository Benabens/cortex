import { generateExam } from "@/lib/exam";
import { useCourse } from "@/lib/req";
import { activeJob, createJobExclusive, startWorker } from "@/lib/jobs";
import { preflightGeneration } from "@/lib/preflight";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Génération d'examen : crée un JOB en arrière-plan et retourne immédiatement {jobId}.
 * Le worker détaché (scripts/run-job.ts) fait le travail (lots + vérif + compile) et survit
 * à la requête / au reload. L'UI poll /api/jobs/:id. (dry-run = stub local synchrone.)
 */
export async function POST(req: NextRequest) {
  const course = useCourse(req);
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  if (dry) {
    try {
      const res = await generateExam({ dry: true });
      return NextResponse.json({ ok: true, ...res });
    } catch (e: any) {
      return NextResponse.json({ error: String(e?.message ?? e) }, { status: 502 });
    }
  }

  const existing = await activeJob("exam");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true });

  // pré-checks AVANT de lancer le worker : claude (Max) + corpus + moteur LaTeX
  const issue = await preflightGeneration();
  if (issue) return NextResponse.json({ error: issue.error, command: issue.command }, { status: issue.status });

  // V9 composeur (CS-202) : count = nombre d'exercices choisi (optionnel ; défaut = blueprint).
  const body = await req.json().catch(() => ({} as any));
  const count = Number(body?.count) > 0 ? Math.min(12, Math.floor(Number(body.count))) : undefined;
  const { id: jobId } = await createJobExclusive("exam", count ? JSON.stringify({ count }) : undefined);
  try {
    await startWorker(jobId, course);
  } catch (e: any) {
    return NextResponse.json({ error: `Impossible de lancer le worker : ${e?.message ?? e}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, jobId });
}
