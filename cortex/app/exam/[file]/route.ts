import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const EXAM_DIR = path.join(process.cwd(), "data", "exams");

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!/^exam-\d+\.html$/.test(file)) return new NextResponse("Bad name", { status: 400 });
  const abs = path.join(EXAM_DIR, file);
  if (!abs.startsWith(EXAM_DIR + path.sep) || !fs.existsSync(abs))
    return new NextResponse("Not found", { status: 404 });
  return new NextResponse(fs.readFileSync(abs, "utf8"), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
