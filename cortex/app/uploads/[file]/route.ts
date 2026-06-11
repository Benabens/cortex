import { coursePaths } from "@/lib/courses";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  // sécurité : nom de fichier simple, pas de traversal
  if (!/^[a-zA-Z0-9._-]+$/.test(file)) return new NextResponse("Bad name", { status: 400 });
  const UPLOAD_DIR = coursePaths(new URL(req.url).searchParams.get("course")).uploadsDir;
  const abs = path.join(UPLOAD_DIR, file);
  if (!abs.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(abs))
    return new NextResponse("Not found", { status: 404 });
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  const buf = fs.readFileSync(abs);
  return new NextResponse(new Uint8Array(buf), {
    headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "private, max-age=3600" },
  });
}
