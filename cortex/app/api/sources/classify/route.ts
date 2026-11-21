import { NextRequest, NextResponse } from "next/server";
import { currentCourse } from "@/db/client";
import { apiError } from "@/lib/i18n/api-error";
import { UserFacingError } from "@/lib/i18n/user-error";
import { activeJob, cancelJob, createJobExclusive, startWorker } from "@/lib/jobs";
import { log } from "@/lib/metrics";
import { maxExamYear, parseClassification, reclassifySource } from "@/lib/reclassify";
import { useCourseOr404 } from "@/lib/req";
import { readJson, withBodyLimit } from "@/lib/upload-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reclasse un fichier mal rangé : `{ path, as: "exam", kind: "final" | "midterm", year }` ou
 * `{ path, as: "support" }` (lib/reclassify). Gratuit : le job d'ingestion du cours (sans crédit)
 * réindexe le corpus depuis le nouvel emplacement. Rend `{ ok, path, jobId }`.
 */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const body = await readJson(req, {});
  const srcPath = typeof body?.path === "string" ? body.path : "";
  if (!srcPath) return apiError(req, "path_missing", 400);
  const c = parseClassification(body);
  if (!c) return apiError(req, { code: "classify_invalid", params: { max: maxExamYear() } }, 400);
  // L'ingestion reconstruit le corpus depuis les fichiers : rien ne bouge pendant qu'elle lit.
  if ((await activeJob("ingest")) || (await activeJob("prepare"))) return apiError(req, "classify_busy", 409);

  const course = currentCourse();
  let jobId: number | null = null;
  try {
    const moved = await reclassifySource(course, srcPath, c, {
      // Réservé avant de déplacer quoi que ce soit : un quota d'imports atteint ne laisse rien à moitié fait.
      beforeWrite: async () => { jobId = (await createJobExclusive("ingest")).id; },
    });
    if (jobId == null) return NextResponse.json({ ok: true, path: moved.path, jobId: null });
    try {
      await startWorker(jobId, course);
    } catch (e) {
      // Le fichier est reclassé ; seule la réindexation attend le prochain import.
      log("error", "sources.classify_worker_not_started", { course, error: (e as Error).message });
      await cancelJob(jobId).catch(() => null);
      return NextResponse.json({ ok: true, path: moved.path, jobId: null });
    }
    return NextResponse.json({ ok: true, path: moved.path, jobId });
  } catch (e) {
    if (jobId != null) await cancelJob(jobId).catch(() => null);
    if (e instanceof UserFacingError) return apiError(req, e, e.status);
    log("error", "sources.classify_failed", { course, error: (e as Error).message });
    return apiError(req, { code: "ingestion_start_failed", params: { detail: (e as Error).message } }, 500);
  }
});
