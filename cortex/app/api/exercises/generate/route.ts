import { apiError } from "@/lib/i18n/api-error";
import { ReservationRefused, activeJob, createJobExclusive, startWorker } from "@/lib/jobs";
import { uploadsDir } from "@/lib/paths";
import { preflightGeneration } from "@/lib/preflight";
import { requireCourse } from "@/lib/req";
import { UPLOAD_LIMITS, readFormData, readJson, withBodyLimit } from "@/lib/upload-limit";
import { fieldTooLong } from "@/lib/field-limits";
import crypto from "node:crypto";
import path from "node:path";
import { putUpload } from "@/lib/originals/intake";
import { currentCourse } from "@/db/client";
import { NextRequest, NextResponse } from "next/server";
import { checkStorage, declaredBytes } from "@/lib/storage-quota";
import { currentUser } from "@/db/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IMG_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/**
 * Exercice ciblé : crée un job 'exercise' en arrière-plan, retourne {jobId} tout de suite.
 * Accepte soit JSON {target}, soit multipart {target?, note?, image?} (image → exo).
 */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  const ct = req.headers.get("content-type") ?? "";

  let payload: { target?: string; imageRel?: string; note?: string } = {};
  if (ct.includes("multipart/form-data")) {
    // Quota de stockage du compte + espace libre du volume, AVANT de lire l'envoi.
    const storage = await checkStorage(currentUser(), declaredBytes(req));
    if (storage) return apiError(req, storage, storage.status);
    const form = await readFormData(req, UPLOAD_LIMITS.image);
    const target = String(form.get("target") ?? "").trim();
    const note = String(form.get("note") ?? "").trim();
    const file = form.get("image");
    let imageRel: string | undefined;
    if (file instanceof File && file.size > 0) {
      if (file.size > 12 * 1024 * 1024) return apiError(req, { code: "image_too_large", params: { maxMb: 12 } }, 400);
      const dir = uploadsDir();
      const name = `exo-${crypto.randomUUID()}.${IMG_EXT[file.type] ?? "png"}`;
      // Compte gratuit : en transit seulement, jamais au seau (lib/originals).
      await putUpload(currentCourse(), path.join(dir, name), Buffer.from(await file.arrayBuffer()));
      imageRel = `${path.relative(process.cwd(), dir)}/${name}`;
    }
    payload = { target: target || undefined, note: note || undefined, imageRel };
  } else {
    const { target } = await readJson(req, ({ target: "" }));
    payload = { target: String(target ?? "").trim() || undefined };
  }

  const tooLong = fieldTooLong(req, "target", payload.target ?? "") ?? fieldTooLong(req, "note", payload.note ?? "");
  if (tooLong) return tooLong;
  if (!payload.target && !payload.imageRel) {
    return apiError(req, "exercise_topic_or_image_required", 400);
  }

  const existing = await activeJob("exercise");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true });

  // target du job = texte simple (rétrocompat) OU JSON {target,imageRel,note} si image/note présentes
  const jobTarget = payload.imageRel || payload.note ? JSON.stringify(payload) : (payload.target ?? "");
  // pré-checks AVANT de lancer le worker : limites d'usage, fournisseur LLM, corpus, moteur LaTeX
  const issue = await preflightGeneration("exercise", jobTarget);
  if (issue) return apiError(req, issue, issue.status, { command: issue.command });
  let jobId: number;
  try {
    ({ id: jobId } = await createJobExclusive("exercise", jobTarget));
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
  return NextResponse.json({ ok: true, jobId });
})
