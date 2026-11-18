import { coursePaths } from "@/lib/courses";
import { servedFileHeaders } from "@/lib/security-headers";
import { requireCourse } from "@/lib/req";
import { storage } from "@/lib/storage";
import { currentUser } from "@/db/context";
import { serveCounted } from "@/lib/served-bytes";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requestLocale } from "@/lib/i18n/api-error";
import { translator } from "@/lib/i18n/translate";

export const runtime = "nodejs";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  // Contexte {user, cours} OBLIGATOIRE : les uploads sont rangés par
  // utilisateur (data/u/<user>/uploads) — sans lui, la lecture viserait le
  // dossier du user par défaut et aucun screenshot ne serait retrouvé.
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  const { file } = await params;
  // sécurité : nom de fichier simple, pas de traversal
  if (!/^[a-zA-Z0-9._-]+$/.test(file)) return new NextResponse("Bad name", { status: 400 });
  // Cours VALIDÉ par la garde, jamais le paramètre d'URL relu à part.
  const UPLOAD_DIR = coursePaths(course).uploadsDir;
  const abs = path.join(UPLOAD_DIR, file);
  if (!abs.startsWith(UPLOAD_DIR + path.sep)) return new NextResponse("Not found", { status: 404 });
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  // Relayé par le serveur : borné par compte et par jour (audit fuites I6).
  const res = await serveCounted(currentUser(), () => storage().serve(abs, req, {
    contentType: MIME[ext] ?? "application/octet-stream",
    headers: servedFileHeaders(MIME[ext] ?? "application/octet-stream", { "cache-control": "private, max-age=3600" }),
  }));
  if (res) return res;
  // Compte gratuit (lib/originals) : une pièce jointe ne reste que le temps de sa lecture.
  const { originalsHomeFor, transitHours } = await import("@/lib/originals/intake");
  if ((await originalsHomeFor(course)) === "local") {
    return new NextResponse(
      translator(requestLocale(req))("originals.attachmentGone", { hours: transitHours() }),
      { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  return new NextResponse("Not found", { status: 404 });
}
