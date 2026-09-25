import { coursePaths } from "@/lib/courses";
import { servedFileHeaders } from "@/lib/security-headers";
import { authEnabled } from "@/lib/auth";
import { useCourseOr404 } from "@/lib/req";
import { q } from "@/db/q";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  // contexte {user, cours} → tenant DB, + garde d'accès au cours (ownership ci-dessous)
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const { file } = await params;
  if (!/^(exam|qcm)-\d+(-corrige)?\.(pdf|html)$/.test(file)) return new NextResponse("Bad name", { status: 400 });
  // OWNERSHIP : avec l'auth active, un artefact n'est servi
  // que si son id existe dans la table exams du TENANT du demandeur (les ids
  // sont séquentiels → sans ce contrôle, énumération triviale des examens des
  // autres users). Dev sans auth : comportement historique.
  if (authEnabled()) {
    const id = Number(file.match(/-(\d+)/)![1]);
    const owned = await q.get<{ id: number }>(`SELECT id FROM exams WHERE id = ?`, id).catch(() => undefined);
    if (!owned) return new NextResponse("Not found", { status: 404 });
  }
  // dossier scopé au cours (cs-202 → data/exams ; autres → data/<id>/exams)
  const EXAM_DIR = coursePaths(new URL(req.url).searchParams.get("course")).examsDir;
  const abs = path.join(EXAM_DIR, file);
  if (!abs.startsWith(EXAM_DIR + path.sep) || !fs.existsSync(abs))
    return new NextResponse("Not found", { status: 404 });
  const ext = file.split(".").pop()!.toLowerCase();
  const buf = fs.readFileSync(abs);
  return new NextResponse(new Uint8Array(buf), {
    headers: servedFileHeaders(MIME[ext] ?? "application/octet-stream", { "content-disposition": `inline; filename="${file}"` }),
  });
}
