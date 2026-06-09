import { checkSolution } from "@/lib/check-solution";
import { ClaudeCodeError } from "@/lib/claude-code";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 220;

const UPLOAD_DIR = path.join(process.cwd(), "data", "uploads");
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";
  let statement = "";
  let answer = "";
  let imageRel: string | null = null;

  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    statement = String(form.get("statement") ?? "").trim();
    answer = String(form.get("answer") ?? "").trim();
    const file = form.get("image");
    if (file instanceof File && file.size > 0) {
      const ext = EXT[file.type] ?? "png";
      if (file.size > 12 * 1024 * 1024) return NextResponse.json({ error: "Image trop lourde (max 12 Mo)." }, { status: 400 });
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const name = `${crypto.randomUUID()}.${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(await file.arrayBuffer()));
      imageRel = `data/uploads/${name}`;
    }
  } else {
    const body = await req.json().catch(() => ({}));
    statement = String(body.statement ?? "").trim();
    answer = String(body.answer ?? "").trim();
  }

  if (!statement) return NextResponse.json({ error: "Énoncé manquant." }, { status: 400 });
  if (!answer && !imageRel) return NextResponse.json({ error: "Donne ta réponse (texte ou photo)." }, { status: 400 });

  try {
    const result = await checkSolution({ statement, answer, imageRel });
    return NextResponse.json({ ok: true, result });
  } catch (e: unknown) {
    const err = e as ClaudeCodeError;
    const status = err.code === "UNAVAILABLE" ? 503 : 502;
    return NextResponse.json({ error: err.message ?? String(e), code: err.code }, { status });
  }
}
