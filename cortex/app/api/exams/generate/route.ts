import { generateExam } from "@/lib/exam";
import { requireCourse } from "@/lib/req";
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
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
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

  // pré-checks AVANT de lancer le worker : fournisseur LLM + corpus + moteur LaTeX
  const issue = await preflightGeneration("exam");
  if (issue) return NextResponse.json({ error: issue.error, command: issue.command }, { status: issue.status });

  // composeur (CS-202) : count = nombre d'exercices choisi (optionnel ; défaut = blueprint).
  // Focus = « Mets l'accent sur… » (générique, supporté PARTOUT) — 1-2 exos ciblés.
  const body = await req.json().catch(() => ({} as any));
  const count = Number(body?.count) > 0 ? Math.min(12, Math.floor(Number(body.count))) : undefined;
  const focus = typeof body?.focus === "string" && body.focus.trim() ? body.focus.trim().slice(0, 400) : undefined;
  const target = count || focus ? JSON.stringify({ count, focus }) : undefined;
  const { id: jobId } = await createJobExclusive("exam", target);
  try {
    await startWorker(jobId, course);
  } catch (e: any) {
    return NextResponse.json({ error: `Impossible de lancer le worker : ${e?.message ?? e}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, jobId });
}
