import { isQcmCourse } from "@/lib/format";
import { activeJob, createJob, startWorker } from "@/lib/jobs";
import { preflightGeneration } from "@/lib/preflight";
import { getTopic, topicTarget } from "@/lib/program";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * « M'entraîner sur ce type » — QCM-FIRST (V10) : pour un cours QCM-dominant (ML/CS-233, Algo/CS-250),
 * on compose un petit lot QCM (+ 1 ouverte) sur CE type via le composeur (job 'qcm' → site /mock
 * auto-corrigé). Pour CS-202 (calcul/trace), on garde l'exo architecte ouvert (job 'exercise').
 * Le `topicId` est suivi côté UI (trainTopic) → le score de maîtrise s'attribue au bon type.
 */
export async function POST(req: NextRequest) {
  const course = useCourse(req);
  const { topicId } = await req.json().catch(() => ({ topicId: 0 }));
  const topic = await getTopic(Number(topicId));
  if (!topic) return NextResponse.json({ error: "Type introuvable." }, { status: 404 });

  const qcm = await isQcmCourse();
  const jobType = qcm ? "qcm" : "exercise";
  // un job de ce type en cours ? on le réutilise (un seul actif à la fois).
  const existing = await activeJob(jobType);
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true, topicId: topic.id, qcm });

  const issue = await preflightGeneration();
  if (issue) return NextResponse.json({ error: issue.error, command: issue.command }, { status: issue.status });

  const jobTarget = qcm
    ? JSON.stringify({ count: 4, openCount: 1, focus: topicTarget(topic) }) // QCM-first sur ce type
    : JSON.stringify({ target: topicTarget(topic), topicId: topic.id });
  const jobId = await createJob(jobType, jobTarget);
  try {
    await startWorker(jobId, course);
  } catch (e: any) {
    return NextResponse.json({ error: `Impossible de lancer le worker : ${e?.message ?? e}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, jobId, topicId: topic.id, qcm });
}
