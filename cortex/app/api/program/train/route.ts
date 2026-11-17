import { apiError } from "@/lib/i18n/api-error";
import { planMockExam, resolveExamFormat } from "@/lib/exam-format";
import { ReservationRefused, activeJob, createJobExclusive, startWorker } from "@/lib/jobs";
import { preflightGeneration } from "@/lib/preflight";
import { getTopic, topicTarget } from "@/lib/program";
import { requireCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";
import { readJson, withBodyLimit } from "@/lib/upload-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * « M'entraîner sur ce type » — QCM-FIRST : pour un cours QCM-dominant (ML/CS-233, Algo/CS-250),
 * on compose un petit lot QCM (+ 1 ouverte) sur CE type via le composeur (job 'qcm' → site /mock
 * auto-corrigé). Pour CS-202 (calcul/trace), on garde l'exo architecte ouvert (job 'exercise').
 * Le `topicId` est suivi côté UI (trainTopic) → le score de maîtrise s'attribue au bon type.
 */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  const { topicId } = await readJson(req, ({ topicId: 0 }));
  const topic = await getTopic(Number(topicId));
  if (!topic) return apiError(req, "topic_type_not_found", 404);

  // Même aiguillage que les examens blancs (lib/exam-format) : format inconnu → on le dit, on n'invente pas.
  const plan = planMockExam(await resolveExamFormat(), {});
  if (plan.generator === "none") return apiError(req, "course_exam_format_missing", 409);
  const qcm = plan.generator === "qcm";
  const jobType = qcm ? "qcm" : "exercise";
  // un job de ce type en cours ? on le réutilise (un seul actif à la fois).
  const existing = await activeJob(jobType);
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true, topicId: topic.id, qcm });

  const jobTarget = qcm
    ? JSON.stringify({ count: 4, openCount: 1, focus: topicTarget(topic) }) // QCM-first sur ce type
    : JSON.stringify({ target: topicTarget(topic), topicId: topic.id });
  const issue = await preflightGeneration(jobType, jobTarget);
  if (issue) return apiError(req, issue, issue.status, { command: issue.command });
  let jobId: number;
  try {
    ({ id: jobId } = await createJobExclusive(jobType, jobTarget));
  } catch (e) {
    if (e instanceof ReservationRefused) return apiError(req, e, e.status);
    throw e;
  }
  try {
    await startWorker(jobId, course);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return apiError(req, { code: "worker_start_failed", params: { detail } }, 500);
  }
  return NextResponse.json({ ok: true, jobId, topicId: topic.id, qcm });
})
