import { coursePaths } from "@/lib/courses";
import { servedFileHeaders } from "@/lib/security-headers";
import { useCourseOr404 } from "@/lib/req";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  // Contexte {user, cours} OBLIGATOIRE : les uploads sont rangés par
  // utilisateur (data/u/<user>/uploads) — sans lui, la lecture viserait le
  // dossier du user par défaut et aucun screenshot ne serait retrouvé.
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const { file } = await params;
  // sécurité : nom de fichier simple, pas de traversal
  if (!/^[a-zA-Z0-9._-]+$/.test(file)) return new NextResponse("Bad name", { status: 400 });
  const UPLOAD_DIR = coursePaths(req.nextUrl.searchParams.get("course")).uploadsDir;
  const abs = path.join(UPLOAD_DIR, file);
  if (!abs.startsWith(UPLOAD_DIR + path.sep) || !fs.existsSync(abs))
    return new NextResponse("Not found", { status: 404 });
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  const buf = fs.readFileSync(abs);
  return new NextResponse(new Uint8Array(buf), {
    headers: servedFileHeaders(MIME[ext] ?? "application/octet-stream", { "cache-control": "private, max-age=3600" }),
  });
}
