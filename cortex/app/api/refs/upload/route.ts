import { coursePaths } from "@/lib/courses";
import { createJobExclusive, ReservationRefused, startWorker } from "@/lib/jobs";
import { requireCourse } from "@/lib/req";
import { UPLOAD_LIMITS, readFormData, withBodyLimit } from "@/lib/upload-limit";
import { ingestRefFile } from "@/lib/sources";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { checkStorage, declaredBytes } from "@/lib/storage-quota";
import { currentUser } from "@/db/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upload de finals récents : on les range dans data/<course>/refs/, on les ingère
 * (corpus + exam_refs), puis on relance la DÉTECTION DE FORMAT (job) → l'examen blanc se cale
 * sur ces finals. PDF/HTML/txt acceptés.
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
  fs.mkdirSync(refsDir, { recursive: true });
  const saved: string[] = [];
  for (const f of files) {
    if (f.size > 30 * 1024 * 1024) continue;
    const safe = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, "_");
    if (!/\.(pdf|html?|txt|md)$/i.test(safe)) continue;
    fs.writeFileSync(path.join(refsDir, safe), Buffer.from(await f.arrayBuffer()));
    try { await ingestRefFile(`refs/${safe}`); saved.push(safe); } catch (e) { /* fichier illisible */ }
  }
  if (!saved.length) return NextResponse.json({ error: "Aucun fichier exploitable (PDF/HTML/txt)." }, { status: 400 });

  // relance la détection de format en arrière-plan (se cale sur les annales, dont les nouvelles).
  // Ce job fait de la vision LLM → quota + crédits ; si le gate
  // refuse, l'UPLOAD reste acquis (contenu), seul le job de format est différé.
  let formatJobId: number | undefined;
  let formatSkipped: string | undefined;
  const { generationGate } = await import("@/lib/billing/guards");
  const { creditsGate } = await import("@/lib/billing/credits");
  const gate = (await generationGate("gen")) ?? (await creditsGate("format"));
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
  return NextResponse.json({ ok: true, files: saved, formatJobId, formatSkipped });
})
