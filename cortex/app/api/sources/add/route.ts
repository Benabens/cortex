import { apiError, fileErrorText } from "@/lib/i18n/api-error";
import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/db/context";
import { SOURCE_CATEGORIES, SourceError, addFileSource, type SourceCategory } from "@/lib/course-source";
import { activeJob, createJobExclusive, startWorker } from "@/lib/jobs";
import { requireCourse } from "@/lib/req";
import { checkIndexQuota } from "@/lib/originals/index-quota";
import { checkStorage, declaredBytes } from "@/lib/storage-quota";
import { UPLOAD_LIMITS, readFormData, withBodyLimit } from "@/lib/upload-limit";
import { errorForFile, type UserError } from "@/lib/i18n/user-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DÉPÔT DE FICHIERS D'UNE CATÉGORIE IMPOSÉE — « questions d'exemple officielles »
 * ou « consignes d'examen » (et les autres catégories du connecteur). Même voie que
 * add_course_source (lib/course-source : formats, plafond, quota, chemin confiné),
 * puis l'ingestion du cours. C'est ce qui donne un format et un style d'examen à
 * un cours sans annale (lib/format, lib/qcm).
 */
const MAX_FILES = 20;

export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  const category = req.nextUrl.searchParams.get("category") ?? "";
  if (!(SOURCE_CATEGORIES as readonly string[]).includes(category)) {
    return apiError(req, "source_category_unknown", 400);
  }
  const storage = await checkStorage(currentUser(), declaredBytes(req));
  if (storage) return apiError(req, storage, storage.status);
  // Compte gratuit : ses originaux ne restent pas, c'est son index qui est borné (lib/originals).
  // Refus avant de lire le corps ; addFileSource revérifie (même règle que l'outil MCP).
  const indexFull = await checkIndexQuota(currentUser());
  if (indexFull) return apiError(req, indexFull, indexFull.status);
  const form = await readFormData(req, UPLOAD_LIMITS.source);
  if (!form) return apiError(req, "multipart_expected", 400);
  const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return apiError(req, "no_file", 400);
  if (files.length > MAX_FILES) return apiError(req, { code: "too_many_files", params: { count: files.length, max: MAX_FILES } }, 400);

  // Un fichier refusé n'empêche pas d'indexer ceux qui sont déjà rangés.
  const saved: string[] = [];
  const refused: { file: string; userError: UserError; status: number }[] = [];
  for (const f of files) {
    try {
      const s = await addFileSource(course, { name: f.name, data: Buffer.from(await f.arrayBuffer()), category: category as SourceCategory, contentType: f.type || "application/octet-stream" });
      saved.push(s.name);
    } catch (e) {
      if (!(e instanceof SourceError)) throw e;
      refused.push({ file: f.name, userError: e, status: e.status });
    }
  }
  if (!saved.length) {
    const first = refused[0];
    return apiError(req, errorForFile(first.userError, first.file), first.status);
  }
  const skipped = refused.map((r) => fileErrorText(req, r.file, r.userError));

  const existing = await activeJob("ingest");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true, files: saved.length, skipped });
  const { id: jobId } = await createJobExclusive("ingest");
  try {
    await startWorker(jobId, course);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return apiError(req, { code: "worker_start_failed", params: { detail } }, 500);
  }
  return NextResponse.json({ ok: true, jobId, files: saved.length, skipped });
})
