import { coursePaths } from "@/lib/courses";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
};

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!/^exam-\d+(-corrige)?\.(pdf|html)$/.test(file)) return new NextResponse("Bad name", { status: 400 });
  // dossier scopé au cours (cs-202 → data/exams ; autres → data/<id>/exams)
  const EXAM_DIR = coursePaths(new URL(req.url).searchParams.get("course")).examsDir;
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
