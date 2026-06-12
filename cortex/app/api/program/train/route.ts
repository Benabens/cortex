import { activeJob, createJob, startWorker } from "@/lib/jobs";
import { preflightGeneration } from "@/lib/preflight";
import { getTopic, topicTarget } from "@/lib/program";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PHASE 3/4 — « M'entraîner sur ce type » : génère un exo NEUF du type choisi via le générateur
 * d'exo ciblé existant (job 'exercise' en arrière-plan, vérifié à l'aveugle, format examen).
 * Le `topicId` est embarqué dans la cible du job → l'UI sait à quel type attribuer le score.
 */
export async function POST(req: NextRequest) {
  const course = useCourse(req);
  const { topicId } = await req.json().catch(() => ({ topicId: 0 }));
  const topic = getTopic(Number(topicId));
  if (!topic) return NextResponse.json({ error: "Type introuvable." }, { status: 404 });

  // un exo en cours ? on le réutilise (un seul job 'exercise' actif à la fois).
  const existing = activeJob("exercise");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true, topicId: topic.id });

  const issue = preflightGeneration();
  if (issue) return NextResponse.json({ error: issue.error, command: issue.command }, { status: issue.status });

  const jobTarget = JSON.stringify({ target: topicTarget(topic), topicId: topic.id });
  const jobId = createJob("exercise", jobTarget);
  try {
    startWorker(jobId, course);
  } catch (e: any) {
    return NextResponse.json({ error: `Impossible de lancer le worker : ${e?.message ?? e}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, jobId, topicId: topic.id });
}
