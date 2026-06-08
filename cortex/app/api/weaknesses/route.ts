import { createWeakness, deleteWeakness, listWeaknesses } from "@/lib/weaknesses";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPLOAD_DIR = path.join(process.cwd(), "data", "uploads");
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function GET() {
  return NextResponse.json({ weaknesses: listWeaknesses() });
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const topic = String(form.get("topic") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  const severity = Number(form.get("severity") ?? 2);
  if (!topic) return NextResponse.json({ error: "Le sujet est requis." }, { status: 400 });

  let screenshotPath: string | null = null;
  const file = form.get("screenshot");
  if (file && file instanceof File && file.size > 0) {
    const ext = EXT[file.type] ?? "png";
    if (file.size > 12 * 1024 * 1024)
      return NextResponse.json({ error: "Image trop lourde (max 12 Mo)." }, { status: 400 });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const name = `${crypto.randomUUID()}.${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    screenshotPath = name;
  }

  const id = createWeakness({ topic, description, severity, screenshotPath });
  return NextResponse.json({ id });
}

export function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "id manquant" }, { status: 400 });
  const screenshot = deleteWeakness(id);
  if (screenshot) {
    const p = path.join(UPLOAD_DIR, path.basename(screenshot));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  return NextResponse.json({ ok: true });
}
