import { coursePaths } from "@/lib/courses";
import { createJobExclusive, ReservationRefused, startWorker } from "@/lib/jobs";
import { requireCourse } from "@/lib/req";
import { UPLOAD_LIMITS, readFormData, withBodyLimit } from "@/lib/upload-limit";
import { ingestRefFile } from "@/lib/sources";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { checkStorage, declaredBytes } from "@/lib/storage-quota";
import { currentUser } from "@/db/context";
import { storage as fileStore } from "@/lib/storage";
import { storedFileName, storeUnique } from "@/lib/stored-file";
import { IMAGE_FILE, IMAGE_REFUSAL } from "@/lib/folder-import";
import { unreadableDocument } from "@/lib/document-check";
import { failureStatus, problemMessage } from "@/lib/ingest-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upload de finals récents : on les range dans data/<course>/refs/, on les ingère
 * (corpus + exam_refs), puis on relance la DÉTECTION DE FORMAT (job) → l'examen blanc se cale
 * sur ces finals. PDF, Word, PowerPoint, HTML et texte acceptés.
 */
const REF_EXTENSIONS = /\.(pdf|html?|txt|md|docx|pptx)$/i;
const REF_MAX_BYTES = 30 * 1024 * 1024;
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  // Quota de stockage du compte + espace libre du volume, AVANT de lire l'envoi.
  const storage = await checkStorage(currentUser(), declaredBytes(req));
  if (storage) return NextResponse.json({ error: storage.error }, { status: storage.status });
  const form = await readFormData(req, UPLOAD_LIMITS.refs);
  if (!form) return NextResponse.json({ error: "multipart attendu." }, { status: 400 });
  const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return NextResponse.json({ error: "Aucun fichier." }, { status: 400 });

  // Chaque fichier écarté est nommé avec sa raison : un dépôt mélangé ne perd rien en silence.
  const refsDir = coursePaths(course).refsDir;
  const saved: string[] = [];
  const skipped: { file: string; reason: string }[] = [];
  for (const f of files) {
    const safe = storedFileName(path.basename(f.name));
    if (f.size > REF_MAX_BYTES) { skipped.push({ file: f.name, reason: "fichier trop volumineux (30 Mo maximum)." }); continue; }
    if (IMAGE_FILE.test(safe)) { skipped.push({ file: f.name, reason: IMAGE_REFUSAL }); continue; }
    if (!REF_EXTENSIONS.test(safe)) { skipped.push({ file: f.name, reason: "format non pris en charge pour une annale : PDF, Word, PowerPoint, HTML ou texte." }); continue; }
    const data = Buffer.from(await f.arrayBuffer());
    const problem = await unreadableDocument(data, path.extname(safe));
    if (problem) { skipped.push({ file: f.name, reason: problem.message }); continue; }
    const stored = await storeUnique(refsDir, safe, data);
    if (!stored) { skipped.push({ file: f.name, reason: "trop d’annales du même nom : renomme le fichier." }); continue; }
    try {
      await ingestRefFile(`refs/${stored.name}`);
      saved.push(stored.name);
    } catch (e) {
      // Rangé mais illisible pour l'ingestion : retiré, sinon il resterait dans les annales sans y figurer.
      if (!stored.duplicate) await fileStore().remove(path.join(refsDir, stored.name)).catch(() => {});
      skipped.push({ file: f.name, reason: problemMessage(failureStatus(e)) });
    }
  }
  if (!saved.length) {
    const first = skipped[0];
    return NextResponse.json({ error: first ? `${first.file} : ${first.reason}` : "Aucun fichier exploitable.", skipped }, { status: 400 });
  }

  // relance la détection de format en arrière-plan (se cale sur les annales, dont les nouvelles).
  // Ce job fait de la vision LLM → quota + crédits ; si le gate
  // refuse, l'UPLOAD reste acquis (contenu), seul le job de format est différé.
  let formatJobId: number | undefined;
  let formatSkipped: string | undefined;
  if (process.env.E2E_TEST_AUTH === "1" && process.env.E2E_TEST_RUN === "1") {
    formatSkipped = "Détection couverte par la préparation hermétique E2E";
    return NextResponse.json({ ok: true, files: saved, skipped, formatSkipped });
  }
  const { jobSpec, launchGate } = await import("@/lib/billing/limits");
  const { costForJob } = await import("@/lib/jobs");
  const gate = await launchGate(jobSpec("format", costForJob("format")));
  if (gate) {
    formatSkipped = gate.error;
  } else {
    try {
      const r = await createJobExclusive("format", JSON.stringify({ reason: "upload", files: saved }));
      formatJobId = r.id;
      if (!r.existing) await startWorker(formatJobId, course);
    } catch (e) {
      if (e instanceof ReservationRefused) formatSkipped = e.message; // l'upload reste acquis
      else throw e;
    }
  }
  return NextResponse.json({ ok: true, files: saved, skipped, formatJobId, formatSkipped });
})
