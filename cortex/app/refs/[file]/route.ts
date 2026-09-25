import { coursePaths } from "@/lib/courses";
import { servedFileHeaders } from "@/lib/security-headers";
import { useCourseOr404 } from "@/lib/req";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
};

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  // Garde d'APPARTENANCE : les annales d'un cours créé depuis l'interface vivent
  // sous le dossier de son propriétaire. Sans ce contrôle, `?course=<cours d'un
  // autre>` suffirait à les télécharger.
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const { file } = await params;
  if (!/^[a-zA-Z0-9._-]+$/.test(file)) return new NextResponse("Bad name", { status: 400 });
  const REFS_DIR = coursePaths(new URL(req.url).searchParams.get("course")).refsDir;
  const abs = path.join(REFS_DIR, file);
  if (!abs.startsWith(REFS_DIR + path.sep) || !fs.existsSync(abs))
    return new NextResponse("Not found", { status: 404 });
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  const buf = fs.readFileSync(abs);
  return new NextResponse(new Uint8Array(buf), {
    headers: servedFileHeaders(MIME[ext] ?? "application/octet-stream", { "cache-control": "private, max-age=3600" }),
  });
}
