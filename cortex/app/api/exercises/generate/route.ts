import { activeJob, createJob, startWorker } from "@/lib/jobs";
import { uploadsDir } from "@/lib/paths";
import { preflightGeneration } from "@/lib/preflight";
import { useCourse } from "@/lib/req";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IMG_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/**
 * Exercice ciblé : crée un job 'exercise' en arrière-plan, retourne {jobId} tout de suite.
 * Accepte soit JSON {target}, soit multipart {target?, note?, image?} (Phase 3 : image → exo).
 */
export async function POST(req: NextRequest) {
  const course = useCourse(req);
  const ct = req.headers.get("content-type") ?? "";

  let payload: { target?: string; imageRel?: string; note?: string } = {};
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const target = String(form.get("target") ?? "").trim();
    const note = String(form.get("note") ?? "").trim();
    const file = form.get("image");
    let imageRel: string | undefined;
    if (file instanceof File && file.size > 0) {
      if (file.size > 12 * 1024 * 1024) return NextResponse.json({ error: "Image trop lourde (max 12 Mo)." }, { status: 400 });
      const dir = uploadsDir();
      fs.mkdirSync(dir, { recursive: true });
      const name = `exo-${crypto.randomUUID()}.${IMG_EXT[file.type] ?? "png"}`;
      fs.writeFileSync(path.join(dir, name), Buffer.from(await file.arrayBuffer()));
      imageRel = `${path.relative(process.cwd(), dir)}/${name}`;
    }
    payload = { target: target || undefined, note: note || undefined, imageRel };
  } else {
    const { target } = await req.json().catch(() => ({ target: "" }));
    payload = { target: String(target ?? "").trim() || undefined };
  }

  if (!payload.target && !payload.imageRel) {
    return NextResponse.json({ error: "Donne un sujet OU une image d'exercice." }, { status: 400 });
  }

  const existing = await activeJob("exercise");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true });

  // pré-checks AVANT de lancer le worker : claude (Max) + corpus + moteur LaTeX
  const issue = await preflightGeneration();
  if (issue) return NextResponse.json({ error: issue.error, command: issue.command }, { status: issue.status });

  // target du job = texte simple (rétrocompat) OU JSON {target,imageRel,note} si image/note présentes
  const jobTarget = payload.imageRel || payload.note ? JSON.stringify(payload) : (payload.target ?? "");
  const jobId = await createJob("exercise", jobTarget);
  try {
    await startWorker(jobId, course);
  } catch (e: any) {
    return NextResponse.json({ error: `Impossible de lancer le worker : ${e?.message ?? e}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, jobId });
}
