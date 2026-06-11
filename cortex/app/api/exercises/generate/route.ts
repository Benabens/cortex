import { activeJob, createJob, startWorker } from "@/lib/jobs";
import { preflightGeneration } from "@/lib/preflight";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Exercice ciblé : crée un job 'exercise' en arrière-plan, retourne {jobId} tout de suite. */
export async function POST(req: NextRequest) {
  const { target } = await req.json().catch(() => ({ target: "" }));
  const t = String(target ?? "").trim();
  if (!t) return NextResponse.json({ error: "Sujet manquant." }, { status: 400 });

  const existing = activeJob("exercise");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true });

  // pré-checks AVANT de lancer le worker : claude (Max) + corpus + moteur LaTeX
  const issue = preflightGeneration();
  if (issue) return NextResponse.json({ error: issue.error, command: issue.command }, { status: issue.status });

  const jobId = createJob("exercise", t);
  try {
    startWorker(jobId);
  } catch (e: any) {
    return NextResponse.json({ error: `Impossible de lancer le worker : ${e?.message ?? e}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, jobId });
}
