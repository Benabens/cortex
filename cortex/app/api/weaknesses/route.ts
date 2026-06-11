import { createWeakness, deleteWeakness, listWeaknesses, weaknessesByTheme } from "@/lib/weaknesses";
import { useCourse } from "@/lib/req";
import { uploadsDir } from "@/lib/paths";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function GET(req: NextRequest) {
  useCourse(req);
  return NextResponse.json({ weaknesses: listWeaknesses(), byTheme: weaknessesByTheme() });
}

export async function POST(req: NextRequest) {
  useCourse(req);
  const form = await req.formData();
  let topic = String(form.get("topic") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  const severity = Number(form.get("severity") ?? 2);

  let screenshotPath: string | null = null;
  const file = form.get("screenshot");
  const hasFile = file && file instanceof File && file.size > 0;
  // Sujet optionnel : l'IA le déduira. Il faut au moins un screenshot OU une note.
  if (!topic && !description && !hasFile) {
    return NextResponse.json({ error: "Mets au moins un screenshot ou une note." }, { status: 400 });
  }
  if (!topic) topic = "(à analyser)";
  if (file && file instanceof File && file.size > 0) {
    const ext = EXT[file.type] ?? "png";
    if (file.size > 12 * 1024 * 1024)
      return NextResponse.json({ error: "Image trop lourde (max 12 Mo)." }, { status: 400 });
    fs.mkdirSync(uploadsDir(), { recursive: true });
    const name = `${crypto.randomUUID()}.${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(path.join(uploadsDir(), name), buf);
    screenshotPath = name;
  }

  const id = createWeakness({ topic, description, severity, screenshotPath });
  return NextResponse.json({ id });
}

export function DELETE(req: NextRequest) {
  useCourse(req);
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "id manquant" }, { status: 400 });
  const screenshot = deleteWeakness(id);
  if (screenshot) {
    const p = path.join(uploadsDir(), path.basename(screenshot));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  return NextResponse.json({ ok: true });
}
