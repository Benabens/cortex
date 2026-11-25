import { apiError } from "@/lib/i18n/api-error";
import { ASSIST_FROM_WEB, ReservationRefused } from "@/lib/jobs";
import { useCourseOr404 } from "@/lib/req";
import { UPLOAD_LIMITS, readFormData, readJson, withBodyLimit } from "@/lib/upload-limit";
import { fieldTooLong } from "@/lib/field-limits";
import { logLoopRoute } from "@/lib/req-log";
import { uploadsDir } from "@/lib/paths";
import crypto from "node:crypto";
import path from "node:path";
import { putUpload } from "@/lib/originals/intake";
import { currentCourse } from "@/db/client";
import { NextRequest, NextResponse } from "next/server";
import { checkStorage, declaredBytes } from "@/lib/storage-quota";
import { currentUser } from "@/db/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    return await handlePOST(req);
  } finally {
    logLoopRoute(req, "check-solution", t0);
  }
})

/**
 * Lance la correction EN JOB (24/11/2026) : la requête rend `jobId` tout de suite, le worker corrige
 * (lib/check-job), la page suit le job et lit la correction sur /api/jobs/[id]. Avant, la requête
 * attendait le modèle une à deux minutes : quitter la page ou recharger perdait la correction payée.
 * `examId` + `questionId` (ou `partId`) : la question corrigée, que la page retrouve au retour.
 */
async function handlePOST(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const ct = req.headers.get("content-type") ?? "";
  let statement = "";
  let answer = "";
  let image: string | undefined;
  let part: { examId: number; partId: number } | undefined;
  let question: { examId: number; questionId: number } | undefined;

  if (ct.includes("multipart/form-data")) {
    // Quota de stockage du compte + espace libre du volume, AVANT de lire l'envoi.
    const storage = await checkStorage(currentUser(), declaredBytes(req));
    if (storage) return apiError(req, storage, storage.status);
    const form = await readFormData(req, UPLOAD_LIMITS.image);
    statement = String(form.get("statement") ?? "").trim();
    answer = String(form.get("answer") ?? "").trim();
    const file = form.get("image");
    if (file instanceof File && file.size > 0) {
      const ext = EXT[file.type] ?? "png";
      if (file.size > 12 * 1024 * 1024) return apiError(req, { code: "image_too_large", params: { maxMb: 12 } }, 400);
      const name = `${crypto.randomUUID()}.${ext}`;
      // Écrit aussi sur le disque local (copie du seau en stockage objet) : l'outil Read du modèle l'y lit.
      // Compte gratuit : en transit seulement, jamais au seau (lib/originals).
      await putUpload(currentCourse(), path.join(uploadsDir(), name), Buffer.from(await file.arrayBuffer()));
      // Le job ne garde que le NOM : le worker refait le chemin dans les envois du cours (lib/check-job).
      image = name;
    }
  } else {
    const body = await readJson(req, ({}));
    statement = String(body.statement ?? "").trim();
    answer = String(body.answer ?? "").trim();
    // Réponse courte d'une question composée : énoncé, barème et réponse modèle viennent de la base.
    if (body.partId !== undefined) {
      const { shortPartForCheck } = await import("@/lib/blocks");
      const found = await shortPartForCheck(Number(body.examId), Number(body.partId));
      if (!found) return apiError(req, "exam_part_not_found", 404);
      ({ statement } = found);
      part = { examId: Number(body.examId), partId: Number(body.partId) };
      question = { examId: part.examId, questionId: part.partId };
    } else if (Number.isInteger(body.examId) && Number.isInteger(body.questionId)) {
      question = { examId: Number(body.examId), questionId: Number(body.questionId) };
    }
  }

  if (!statement) return apiError(req, "statement_missing", 400);
  const tooLong = fieldTooLong(req, "statement", statement) ?? fieldTooLong(req, "answer", answer);
  if (tooLong) return tooLong;
  if (!answer && !image) return apiError(req, "answer_required", 400);

  try {
    const { startCheckJob } = await import("@/lib/check-job");
    const { jobId } = await startCheckJob({ statement, answer, ...(image ? { image } : {}), ...(part ? { part } : {}), ...(question ? { question } : {}), ...ASSIST_FROM_WEB });
    return NextResponse.json({ ok: true, jobId });
  } catch (e: unknown) {
    const { AssistRefused } = await import("@/lib/billing/reserve");
    if (e instanceof AssistRefused) return apiError(req, e, e.status);
    if (e instanceof ReservationRefused) return apiError(req, e, e.status);
    throw e;
  }
}
