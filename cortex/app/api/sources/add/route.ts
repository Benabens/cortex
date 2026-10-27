import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/db/context";
import { SOURCE_CATEGORIES, SourceError, addFileSource, type SourceCategory } from "@/lib/course-source";
import { activeJob, createJobExclusive, startWorker } from "@/lib/jobs";
import { requireCourse } from "@/lib/req";
import { checkStorage, declaredBytes } from "@/lib/storage-quota";
import { UPLOAD_LIMITS, readFormData, withBodyLimit } from "@/lib/upload-limit";

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
    return NextResponse.json({ error: "Catégorie de document inconnue." }, { status: 400 });
  }
  const storage = await checkStorage(currentUser(), declaredBytes(req));
  if (storage) return NextResponse.json({ error: storage.error }, { status: storage.status });
  const form = await readFormData(req, UPLOAD_LIMITS.source);
  if (!form) return NextResponse.json({ error: "Envoi multipart attendu." }, { status: 400 });
  const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return NextResponse.json({ error: "Aucun fichier." }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ error: `Trop de fichiers (${files.length}, maximum ${MAX_FILES}).` }, { status: 400 });

  // Un fichier refusé n'empêche pas d'indexer ceux qui sont déjà rangés.
  const saved: string[] = [];
  const refused: { file: string; error: string; status: number }[] = [];
  for (const f of files) {
    try {
      const s = await addFileSource(course, { name: f.name, data: Buffer.from(await f.arrayBuffer()), category: category as SourceCategory, contentType: f.type || "application/octet-stream" });
      saved.push(s.name);
    } catch (e) {
      if (!(e instanceof SourceError)) throw e;
      refused.push({ file: f.name, error: e.message, status: e.status });
    }
  }
  if (!saved.length) {
    const first = refused[0];
    return NextResponse.json({ error: `${first.file} : ${first.error}` }, { status: first.status });
  }
  const skipped = refused.map((r) => `${r.file} : ${r.error}`);

  const existing = await activeJob("ingest");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true, files: saved.length, skipped });
  const { id: jobId } = await createJobExclusive("ingest");
  try {
    await startWorker(jobId, course);
  } catch (e) {
    return NextResponse.json({ error: `Impossible de lancer le worker : ${(e as Error)?.message ?? e}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, jobId, files: saved.length, skipped });
})
