import { apiError } from "@/lib/i18n/api-error";
import { currentUser } from "@/db/context";
import { coursePaths, getCourse } from "@/lib/courses";
import { FOLDER_EXTENSIONS, IMAGE_FILE, LEGACY_FILE, SOURCE_FILE_MAX_BYTES } from "@/lib/folder-import";
import { classifyFile } from "@/lib/import-folder";
import { activeJob, createJobExclusive, startWorker } from "@/lib/jobs";
import { unreadableDocument } from "@/lib/document-check";
import { requireCourse } from "@/lib/req";
import { checkIndexQuota } from "@/lib/originals/index-quota";
import { checkStorage, declaredBytes, storageQuotaBytesFor } from "@/lib/storage-quota";
import { readFormData, UPLOAD_LIMITS, withBodyLimit } from "@/lib/upload-limit";
import path from "node:path";
import { storage as fileStore } from "@/lib/storage";
import { storedFileName } from "@/lib/stored-file";
import { storeOriginal } from "@/lib/originals/intake";
import { NextRequest, NextResponse } from "next/server";
import { errorForFile } from "@/lib/i18n/user-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set(FOLDER_EXTENSIONS.map((extension) => `.${extension}`));

function safeRelPath(raw: string): string | null {
  const rawParts = raw.split("/").map((part) => part.trim()).filter(Boolean);
  if (rawParts.some((part) => part.startsWith("."))) return null;
  const parts = rawParts
    .filter((part) => part !== "." && part !== "..")
    .map(storedFileName)
    .slice(-4);
  if (!parts.length || !ALLOWED.has(path.extname(parts.at(-1)!).toLowerCase())) return null;
  return parts.join("/");
}

export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  const cfg = getCourse(course);
  if (cfg.paths?.contentRel === "..") {
    return apiError(req, { code: "course_content_read_only", params: { name: cfg.name } }, 409);
  }

  // Requête distincte : l'ingestion ne démarre qu'après le dernier fichier.
  if (req.nextUrl.searchParams.get("action") === "finish") {
    const existing = await activeJob("ingest");
    if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true });
    const { id: jobId } = await createJobExclusive("ingest");
    try { await startWorker(jobId, course); }
    catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return apiError(req, { code: "ingestion_start_failed", params: { detail } }, 500);
    }
    return NextResponse.json({ ok: true, jobId });
  }

  const storage = await checkStorage(currentUser(), declaredBytes(req));
  if (storage) return apiError(req, storage, storage.status);
  // Compte gratuit : ses originaux ne restent pas, c'est son index qui est borné (lib/originals).
  const indexFull = await checkIndexQuota(currentUser());
  if (indexFull) return apiError(req, indexFull, indexFull.status);
  const form = await readFormData(req, UPLOAD_LIMITS.folderFile);
  const files = form.getAll("file").filter((value): value is File => value instanceof File && value.size > 0);
  if (files.length !== 1) return apiError(req, "single_file_required", 400);

  const file = files[0];
  if (IMAGE_FILE.test(file.name)) return apiError(req, { code: "source_image_refused", params: { file: file.name } }, 415);
  if (LEGACY_FILE.test(file.name)) return apiError(req, { code: "source_legacy_format_refused", params: { file: file.name } }, 415);
  const rawRel = String(form.get("relpath") ?? file.name);
  const rel = safeRelPath(rawRel);
  if (!rel) return apiError(req, { code: "source_hidden_or_unsupported", params: { file: file.name } }, 415);
  if (file.size > SOURCE_FILE_MAX_BYTES) {
    return apiError(req, { code: "source_file_too_large", params: { file: file.name, maxMb: 30 } }, 413);
  }

  const { refsDir, contentRoot } = coursePaths(course);
  const courseMax = await storageQuotaBytesFor(currentUser());
  if (courseMax !== null && (await fileStore().usageBytes(refsDir)) + (await fileStore().usageBytes(contentRoot)) + file.size > courseMax) {
    return apiError(req, { code: "course_storage_limit_reached", params: { file: file.name, maxMb: Math.round(courseMax / (1024 * 1024)) } }, 413);
  }

  // Un document qui ne s'ouvre pas est refusé ici, nommé, plutôt que rangé puis ignoré à l'ingestion.
  const buffer = Buffer.from(await file.arrayBuffer());
  const problem = await unreadableDocument(buffer, path.extname(rel));
  if (problem) return apiError(req, errorForFile(problem.error, file.name), problem.status);

  const { bucket } = classifyFile(rel);
  const destDir = bucket === "refs" ? refsDir : path.join(contentRoot, bucket);
  // Premium : rangé dans le cloud ; gratuit : en transit, le temps que l'ingestion lise son texte
  // (lib/originals) — le nom et le chemin d'origine permettent de le retrouver sur l'ordinateur.
  const saved = await storeOriginal(course, destDir, path.basename(rel), buffer, { originalName: file.name, rel: rawRel.slice(0, 400) });
  if (!saved) return apiError(req, { code: "source_duplicate_names", params: { file: file.name } }, 409);
  return NextResponse.json({ ok: true, name: saved.name, bucket, originals: saved.home, ...(saved.duplicate ? { duplicate: true } : {}) });
});
