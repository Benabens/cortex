import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const REFS_DIR = path.join(process.cwd(), "data", "refs");
const MIME: Record<string, string> = {
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
};

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!/^[a-zA-Z0-9._-]+$/.test(file)) return new NextResponse("Bad name", { status: 400 });
  const abs = path.join(REFS_DIR, file);
  if (!abs.startsWith(REFS_DIR + path.sep) || !fs.existsSync(abs))
    return new NextResponse("Not found", { status: 404 });
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  const buf = fs.readFileSync(abs);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": "private, max-age=3600",
    },
  });
}
