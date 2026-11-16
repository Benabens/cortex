import { coursePaths } from "@/lib/courses";
import { requireCourse } from "@/lib/req";
import { UPLOAD_LIMITS, readFormData, withBodyLimit } from "@/lib/upload-limit";
import { ingestRefFile } from "@/lib/sources";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { checkStorage, declaredBytes } from "@/lib/storage-quota";
import { currentUser } from "@/db/context";
import { storage as fileStore } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upload de finals récents : on les range dans data/<course>/refs/ et on les ingère
 * (corpus + exam_refs). GRATUIT, comme tout dépôt : relire le format sur ces annales
 * est une détection payante (vision LLM → crédit + génération du jour), lancée par
 * l'étudiant lui-même via POST /api/refs/format, son coût affiché avant le clic
 * (`formatPending` : l'écran la propose). PDF/HTML/txt acceptés.
 */
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

  const refsDir = coursePaths(course).refsDir;
  const saved: string[] = [];
  for (const f of files) {
    if (f.size > 30 * 1024 * 1024) continue;
    const safe = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, "_");
    if (!/\.(pdf|html?|txt|md)$/i.test(safe)) continue;
    await fileStore().put(path.join(refsDir, safe), Buffer.from(await f.arrayBuffer()));
    try { await ingestRefFile(`refs/${safe}`); saved.push(safe); } catch (e) { /* fichier illisible */ }
  }
  if (!saved.length) return NextResponse.json({ error: "Aucun fichier exploitable (PDF/HTML/txt)." }, { status: 400 });
  return NextResponse.json({ ok: true, files: saved, formatPending: true });
})
