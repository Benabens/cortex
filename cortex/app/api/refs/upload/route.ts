import { coursePaths } from "@/lib/courses";
import { requireCourse } from "@/lib/req";
import { UPLOAD_LIMITS, readFormData, withBodyLimit } from "@/lib/upload-limit";
import { ingestRefFile } from "@/lib/sources";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { checkIndexQuota } from "@/lib/originals/index-quota";
import { checkStorage, declaredBytes } from "@/lib/storage-quota";
import { currentUser } from "@/db/context";
import { storedFileName } from "@/lib/stored-file";
import { discardOriginal, settleOriginals, storeOriginal } from "@/lib/originals/intake";
import { IMAGE_FILE, IMAGE_REFUSAL } from "@/lib/folder-import";
import { unreadableDocument } from "@/lib/document-check";
import { failureStatus, ingestProblems, problemMessage, readStatus, type IngestFileOutcome } from "@/lib/ingest-report";

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
  if (storage) return NextResponse.json({ error: storage.error }, { status: storage.status });
  // Compte gratuit : ses originaux ne restent pas, c'est son index qui est borné (lib/originals).
  const indexFull = await checkIndexQuota(currentUser());
  if (indexFull) return NextResponse.json({ error: indexFull.error }, { status: indexFull.status });
  const form = await readFormData(req, UPLOAD_LIMITS.refs);
  if (!form) return NextResponse.json({ error: "multipart attendu." }, { status: 400 });
  const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return NextResponse.json({ error: "Aucun fichier." }, { status: 400 });

  // Chaque fichier écarté est nommé avec sa raison : un dépôt mélangé ne perd rien en silence.
  const refsDir = coursePaths(course).refsDir;
  const saved: string[] = [];
  const outcomes: IngestFileOutcome[] = [];
  const skipped: { file: string; reason: string }[] = [];
  let local = false;
  for (const f of files) {
    const safe = storedFileName(path.basename(f.name));
    if (f.size > REF_MAX_BYTES) { skipped.push({ file: f.name, reason: "fichier trop volumineux (30 Mo maximum)." }); continue; }
    if (IMAGE_FILE.test(safe)) { skipped.push({ file: f.name, reason: IMAGE_REFUSAL }); continue; }
    if (!REF_EXTENSIONS.test(safe)) { skipped.push({ file: f.name, reason: "format non pris en charge pour une annale : PDF, Word, PowerPoint, HTML ou texte." }); continue; }
    const data = Buffer.from(await f.arrayBuffer());
    const problem = await unreadableDocument(data, path.extname(safe));
    if (problem) { skipped.push({ file: f.name, reason: problem.message }); continue; }
    // Premium : rangée dans le cloud ; gratuit : en transit, le temps de l'indexation (lib/originals).
    const stored = await storeOriginal(course, refsDir, safe, data, { originalName: f.name });
    if (!stored) { skipped.push({ file: f.name, reason: "trop d’annales du même nom : renomme le fichier." }); continue; }
    if (stored.home === "local") local = true;
    try {
      const { items } = await ingestRefFile(`refs/${stored.name}`);
      saved.push(stored.name);
      outcomes.push({ path: `refs/${stored.name}`, status: readStatus(items), items });
    } catch (e) {
      // Rangé mais illisible pour l'ingestion : retiré, sinon il resterait dans les annales sans y figurer.
      if (!stored.duplicate) await discardOriginal(course, path.join(refsDir, stored.name)).catch(() => {});
      skipped.push({ file: f.name, reason: problemMessage(failureStatus(e)) });
    }
  }
  // Gratuit : une annale Word, HTML ou texte part tout de suite ; une annale PDF attend la
  // préparation du cours (lecture des pages en image), 24 h au plus.
  if (local) await settleOriginals({ after: "ingest", paths: outcomes.map((o) => o.path) });
  // Rangée mais sans texte (scan) : gardée, et signalée comme le fait le rapport d'ingestion.
  const unread = ingestProblems({ files: outcomes });
  if (!saved.length) {
    const first = skipped[0];
    return NextResponse.json({ error: first ? `${first.file} : ${first.reason}` : "Aucun fichier exploitable.", skipped }, { status: 400 });
  }
  return NextResponse.json({ ok: true, files: saved, skipped, unread, formatPending: true, originals: local ? "local" : "cloud" });
})
