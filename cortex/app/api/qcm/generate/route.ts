import { apiError } from "@/lib/i18n/api-error";
import { ReservationRefused, activeJob, createJobExclusive, startWorker } from "@/lib/jobs";
import { getFormatProfile } from "@/lib/format";
import { isQcmCourse } from "@/lib/exam-format";
import { preflightGeneration } from "@/lib/preflight";
import { requireCourse, useCourseOr404 } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";
import { fieldTooLong } from "@/lib/field-limits";
import { readJson, withBodyLimit } from "@/lib/upload-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET : le profil de format détecté (pour l'UI). */
export async function GET(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  return NextResponse.json({ format: await getFormatProfile() });
}

/** POST {count?, openCount?, focus?} : compose+génère un examen QCM (job arrière-plan). */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  // composeur : count = N QCM, openCount = M ouvertes, focus = thème ciblé (exercice ciblé).
  // Bornes de champ d'abord — elles ne coûtent rien : un sujet trop long est
  // refusé, jamais tronqué en silence (l'étudiant paierait une intention amputée).
  const body = await readJson(req, {});
  const num = (v: unknown) => (v === 0 || v === "0" ? 0 : Number(v) > 0 ? Math.min(40, Math.floor(Number(v))) : undefined);
  const c = num(body.count);
  const oc = num(body.openCount);
  if (c === 0 && oc === 0) return apiError(req, "qcm_composition_empty", 400);
  const focusRaw = typeof body.focus === "string" ? body.focus.trim() : "";
  const tooLong = fieldTooLong(req, "focus", focusRaw);
  if (tooLong) return tooLong;
  const target = JSON.stringify({ count: c, openCount: oc, focus: focusRaw || undefined });

  // Même aiguillage que le reste (lib/exam-format) : annales, format déclaré, exemples officiels, infos de cours.
  if (!(await isQcmCourse())) return apiError(req, "course_not_qcm", 400);

  const existing = await activeJob("qcm");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true });
  const issue = await preflightGeneration("qcm", target);
  if (issue) return apiError(req, issue, issue.status, { command: issue.command });
  let jobId: number;
  try {
    ({ id: jobId } = await createJobExclusive("qcm", target));
  } catch (e) {
    if (e instanceof ReservationRefused) return apiError(req, e, e.status);
    throw e;
  }
  try { await startWorker(jobId, course); }
  catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return apiError(req, { code: "worker_failed", params: { detail } }, 500);
  }
  return NextResponse.json({ ok: true, jobId });
})
