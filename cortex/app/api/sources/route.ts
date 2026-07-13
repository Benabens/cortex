import {
  addUploadedRef,
  corpusSummary,
  listExamSources,
  removeUploadedRef,
  toggleReference,
} from "@/lib/sources";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  useCourse(req);
  return NextResponse.json({ exams: await listExamSources(), corpus: await corpusSummary() });
}

/** Upload d'un examen de référence (multipart) OU bascule d'une référence (JSON). */
export async function POST(req: NextRequest) {
  useCourse(req);
  const ct = req.headers.get("content-type") ?? "";

  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
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

  const body = await req.json().catch(() => ({}));
  const { path: srcPath, reference } = body as { path?: string; reference?: boolean };
  if (!srcPath) return NextResponse.json({ error: "path manquant" }, { status: 400 });
  await toggleReference(srcPath, !!reference);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  useCourse(req);
  const srcPath = req.nextUrl.searchParams.get("path");
  if (!srcPath) return NextResponse.json({ error: "path manquant" }, { status: 400 });
  await removeUploadedRef(srcPath);
  return NextResponse.json({ ok: true });
}
