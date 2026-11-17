import { apiError } from "@/lib/i18n/api-error";
import { coursePaths } from "@/lib/courses";
import { requireCourse } from "@/lib/req";
import { UPLOAD_LIMITS, readFormData, withBodyLimit } from "@/lib/upload-limit";
import { ingestRefFile } from "@/lib/sources";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { checkIndexQuota, refreshIndexUsage } from "@/lib/originals/index-quota";
import { checkStorage, declaredBytes } from "@/lib/storage-quota";
import { currentUser } from "@/db/context";
import { storedFileName } from "@/lib/stored-file";
import { discardOriginal, settleOriginals, storeOriginal } from "@/lib/originals/intake";
import { IMAGE_FILE } from "@/lib/folder-import";
import { unreadableDocument } from "@/lib/document-check";
import { failureStatus, ingestProblems, readStatus, type IngestFileOutcome } from "@/lib/ingest-report";
import { errorForFile, errorText, userError, type UserError } from "@/lib/i18n/user-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upload de finals récents : on les range dans data/<course>/refs/ et on les ingère
 * (corpus + exam_refs). GRATUIT, comme tout dépôt : relire le format sur ces annales
 * est une détection payante (vision LLM → crédit + génération du jour), lancée par
 * l'étudiant lui-même via POST /api/refs/format, son coût affiché avant le clic
 * (`formatPending` : l'écran la propose). PDF, Word, PowerPoint, HTML et texte acceptés.
 */
const REF_EXTENSIONS = /\.(pdf|html?|txt|md|docx|pptx)$/i;
const REF_MAX_BYTES = 30 * 1024 * 1024;
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  // Quota de stockage du compte + espace libre du volume, AVANT de lire l'envoi.
  const storage = await checkStorage(currentUser(), declaredBytes(req));
  if (storage) return apiError(req, storage, storage.status);
  // Compte gratuit : ses originaux ne restent pas, c'est son index qui est borné (lib/originals).
  const indexFull = await checkIndexQuota(currentUser());
  if (indexFull) return apiError(req, indexFull, indexFull.status);
  const form = await readFormData(req, UPLOAD_LIMITS.refs);
  if (!form) return apiError(req, "multipart_expected", 400);
  const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return apiError(req, "no_file", 400);

  // Chaque fichier écarté est nommé avec sa raison : un dépôt mélangé ne perd rien en silence.
  const refsDir = coursePaths(course).refsDir;
  const saved: string[] = [];
  const outcomes: IngestFileOutcome[] = [];
  const skipped: { file: string; reason: string; userError: UserError }[] = [];
  const skip = (file: string, error: UserError) => skipped.push({ file, reason: errorText("fr", error), userError: error });
  let local = false;
  for (const f of files) {
    const safe = storedFileName(path.basename(f.name));
    if (f.size > REF_MAX_BYTES) { skip(f.name, userError("reference_file_too_large", { maxMb: 30 })); continue; }
    if (IMAGE_FILE.test(safe)) { skip(f.name, userError("reference_image_refused")); continue; }
    if (!REF_EXTENSIONS.test(safe)) { skip(f.name, userError("reference_format_unsupported")); continue; }
    const data = Buffer.from(await f.arrayBuffer());
    const problem = await unreadableDocument(data, path.extname(safe));
    if (problem) { skip(f.name, problem.error); continue; }
    // Premium : rangée dans le cloud ; gratuit : en transit, le temps de l'indexation (lib/originals).
    const stored = await storeOriginal(course, refsDir, safe, data, { originalName: f.name });
    if (!stored) { skip(f.name, userError("reference_duplicate_name")); continue; }
    if (stored.home === "local") local = true;
    try {
      const { items } = await ingestRefFile(`refs/${stored.name}`);
      saved.push(stored.name);
      outcomes.push({ path: `refs/${stored.name}`, status: readStatus(items), items });
    } catch (e) {
      // Rangé mais illisible pour l'ingestion : retiré, sinon il resterait dans les annales sans y figurer.
      if (!stored.duplicate) await discardOriginal(course, path.join(refsDir, stored.name)).catch(() => {});
      const status = failureStatus(e);
      skip(f.name, userError(status === "encrypted" ? "document_encrypted" : "document_unreadable"));
    }
  }
  // Gratuit : une annale Word, HTML ou texte part tout de suite ; une annale PDF attend la
  // préparation du cours (lecture des pages en image), FREE_TRANSIT_HOURS au plus. Le relevé de
  // l'index suit l'envoi : le quota d'un gratuit se juge sur son texte indexé à jour.
  if (local) {
    await settleOriginals({ after: "ingest", paths: outcomes.map((o) => o.path) });
    await refreshIndexUsage(currentUser(), course).catch(() => {});
  }
  // Rangée mais sans texte (scan) : gardée, et signalée comme le fait le rapport d'ingestion.
  const unread = ingestProblems({ files: outcomes });
  if (!saved.length) {
    const first = skipped[0];
    return apiError(req, first ? errorForFile(first.userError, first.file) : "no_usable_file", 400, { skipped: skipped.map(({ file, reason }) => ({ file, reason })) });
  }
  return NextResponse.json({ ok: true, files: saved, skipped, unread, formatPending: true, originals: local ? "local" : "cloud" });
})
