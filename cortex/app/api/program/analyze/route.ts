import { activeJob, createJobExclusive, startWorker } from "@/lib/jobs";
import { preflightGeneration } from "@/lib/preflight";
import { requireCourse, useCourseOr404 } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Job actif d'analyse de blueprint (reprise au reload). */
export async function GET(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  return NextResponse.json({ active: await activeJob("blueprint") });
}

/** Lance l'analyse du programme (taxonomie typée + pondérée) en arrière-plan. */
export async function POST(req: NextRequest) {
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  const existing = await activeJob("blueprint");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true });

  // mêmes pré-checks que la génération : fournisseur LLM + corpus ingéré (le moteur LaTeX n'est pas requis ici).
  const issue = await preflightGeneration("blueprint");
  if (issue && issue.status !== 412) return NextResponse.json({ error: issue.error, command: issue.command }, { status: issue.status });

  const { id: jobId } = await createJobExclusive("blueprint");
  try {
    await startWorker(jobId, course);
  } catch (e: any) {
    return NextResponse.json({ error: `Impossible de lancer le worker : ${e?.message ?? e}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, jobId });
}
