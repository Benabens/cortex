import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const EXAM_DIR = path.join(process.cwd(), "data", "exams");
const MIME: Record<string, string> = {
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
};

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!/^exam-\d+(-corrige)?\.(pdf|html)$/.test(file)) return new NextResponse("Bad name", { status: 400 });
  const abs = path.join(EXAM_DIR, file);
  if (!abs.startsWith(EXAM_DIR + path.sep) || !fs.existsSync(abs))
    return new NextResponse("Not found", { status: 404 });
  const ext = file.split(".").pop()!.toLowerCase();
  const buf = fs.readFileSync(abs);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "content-disposition": `inline; filename="${file}"`,
    },
  });
}
