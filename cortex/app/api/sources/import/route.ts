import { currentUser } from "@/db/context";
import { coursePaths, getCourse } from "@/lib/courses";
import { FOLDER_EXTENSIONS, SOURCE_FILE_MAX_BYTES } from "@/lib/folder-import";
import { classifyFile } from "@/lib/import-folder";
import { activeJob, createJobExclusive, startWorker } from "@/lib/jobs";
import { extractOfficeText, OfficeDocumentError, type OfficeExtension } from "@/lib/office-documents";
import { requireCourse } from "@/lib/req";
import { checkStorage, declaredBytes, storageQuotaBytes } from "@/lib/storage-quota";
import { readFormData, UPLOAD_LIMITS, withBodyLimit } from "@/lib/upload-limit";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set(FOLDER_EXTENSIONS.map((extension) => `.${extension}`));

function safeRelPath(raw: string): string | null {
  const rawParts = raw.split("/").map((part) => part.trim()).filter(Boolean);
  if (rawParts.some((part) => part.startsWith("."))) return null;
  const parts = rawParts
    .filter((part) => part !== "." && part !== "..")
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "_"))
    .slice(-4);
  if (!parts.length || !ALLOWED.has(path.extname(parts.at(-1)!).toLowerCase())) return null;
  return parts.join("/");
}

function directoryBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directoryBytes(child);
    else if (entry.isFile()) { try { total += fs.statSync(child).size; } catch { /* disparu */ } }
  }
  return total;
}

export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  const cfg = getCourse(course);
  if (cfg.paths?.contentRel === "..") {
    return NextResponse.json({ error: `Le contenu de « ${cfg.name} » est en lecture seule.` }, { status: 409 });
  }

  // Requête distincte : l'ingestion ne démarre qu'après le dernier fichier.
  if (req.nextUrl.searchParams.get("action") === "finish") {
    const existing = await activeJob("ingest");
    if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true });
    const { id: jobId } = await createJobExclusive("ingest");
    try { await startWorker(jobId, course); }
    catch (error) {
      return NextResponse.json({ error: `Impossible de lancer l’ingestion : ${(error as Error)?.message ?? error}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true, jobId });
  }

  const storage = await checkStorage(currentUser(), declaredBytes(req));
  if (storage) return NextResponse.json({ error: storage.error }, { status: storage.status });
  const form = await readFormData(req, UPLOAD_LIMITS.folderFile);
  const files = form.getAll("file").filter((value): value is File => value instanceof File && value.size > 0);
  if (files.length !== 1) return NextResponse.json({ error: "Envoie un seul fichier par requête." }, { status: 400 });

  const file = files[0];
  const rel = safeRelPath(String(form.get("relpath") ?? file.name));
  if (!rel) return NextResponse.json({ error: `${file.name} : fichier caché ou format non pris en charge.` }, { status: 415 });
  if (file.size > SOURCE_FILE_MAX_BYTES) {
    return NextResponse.json({ error: `${file.name} : fichier trop volumineux (30 Mo maximum par fichier).` }, { status: 413 });
  }

  let buffer: Buffer | null = null;
  const extension = path.extname(file.name).toLowerCase();
  if (extension === ".docx" || extension === ".pptx") {
    buffer = Buffer.from(await file.arrayBuffer());
    try { await extractOfficeText(buffer, extension as OfficeExtension); }
    catch (error) {
      if (error instanceof OfficeDocumentError) return NextResponse.json({ error: `${file.name} : ${error.message}` }, { status: error.status });
      return NextResponse.json({ error: `${file.name} : document Office illisible.` }, { status: 422 });
    }
  }

  const { refsDir, contentRoot } = coursePaths(course);
  const courseMax = storageQuotaBytes();
  if (courseMax !== null && directoryBytes(refsDir) + directoryBytes(contentRoot) + file.size > courseMax) {
    return NextResponse.json({ error: `${file.name} : plafond de ${Math.round(courseMax / (1024 * 1024))} Mo atteint pour ce cours (quota de stockage configurable).` }, { status: 413 });
  }
  const { bucket } = classifyFile(rel);
  const name = path.basename(rel);
  const destDir = bucket === "refs" ? refsDir : path.join(contentRoot, bucket);
  const absolute = path.join(destDir, name);
  if (!absolute.startsWith(path.resolve(destDir) + path.sep)) return NextResponse.json({ error: `${file.name} : chemin refusé.` }, { status: 400 });
  if (fs.existsSync(absolute)) {
    if (fs.statSync(absolute).size === file.size) return NextResponse.json({ ok: true, duplicate: true, name, bucket });
    return NextResponse.json({ error: `${file.name} : un fichier différent porte déjà ce nom.` }, { status: 409 });
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(absolute, buffer ?? Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ ok: true, name, bucket });
});
