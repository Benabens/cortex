import {
  addUploadedRef,
  corpusSummary,
  listCorpusSources,
  listExamSources,
  removeUploadedRef,
  toggleReference,
} from "@/lib/sources";
import { useCourseOr404 } from "@/lib/req";
import { UPLOAD_LIMITS, readFormData, readJson, withBodyLimit } from "@/lib/upload-limit";
import { NextRequest, NextResponse } from "next/server";
import { checkStorage, declaredBytes } from "@/lib/storage-quota";
import { currentUser } from "@/db/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  return NextResponse.json({
    exams: await listExamSources(),
    corpus: await corpusSummary(),
    sources: await listCorpusSources(),
  });
}

/** Upload d'un examen de référence (multipart) OU bascule d'une référence (JSON). */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const ct = req.headers.get("content-type") ?? "";

  if (ct.includes("multipart/form-data")) {
    // Quota de stockage du compte + espace libre du volume, AVANT de lire l'envoi.
    const storage = await checkStorage(currentUser(), declaredBytes(req));
    if (storage) return NextResponse.json({ error: storage.error }, { status: storage.status });
    const form = await readFormData(req, UPLOAD_LIMITS.source);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: "Aucun fichier." }, { status: 400 });
    }
    const okExt = /\.(pdf|html?|txt|md)$/i.test(file.name);
    if (!okExt) {
      return NextResponse.json({ error: "Formats acceptés : PDF, HTML, TXT, MD." }, { status: 400 });
    }
    if (file.size > 30 * 1024 * 1024) {
      return NextResponse.json({ error: "Fichier trop lourd (max 30 Mo)." }, { status: 400 });
    }
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      const exam = await addUploadedRef(buf, file.name);
      return NextResponse.json({ exam });
    } catch (e: any) {
      return NextResponse.json({ error: `Échec de l'indexation : ${e.message ?? e}` }, { status: 500 });
    }
  }

  const body = await readJson(req, ({}));
  const { path: srcPath, reference } = body as { path?: string; reference?: boolean };
  if (!srcPath) return NextResponse.json({ error: "path manquant" }, { status: 400 });
  await toggleReference(srcPath, !!reference);
  return NextResponse.json({ ok: true });
})

export async function DELETE(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const srcPath = req.nextUrl.searchParams.get("path");
  if (!srcPath) return NextResponse.json({ error: "path manquant" }, { status: 400 });
  await removeUploadedRef(srcPath);
  return NextResponse.json({ ok: true });
}
