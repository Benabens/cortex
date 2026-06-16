import { coursePaths } from "@/lib/courses";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * V6 — service de fichier SOURCE, course-aware, pour le deep-link clic→source de la recherche.
 *   /csrc?course=<id>&p=<chemin relatif>#page=N
 * Résout `p` sous le cours : `refs/<f>` → refsDir ; sinon → contentRoot (le PDF s'ouvre à la
 * page via le fragment #page=N, géré par le viewer du navigateur — non vu par le serveur).
 * Sécurité : le chemin résolu DOIT rester sous refsDir ou contentRoot du cours.
 */
const MIME: Record<string, string> = {
  pdf: "application/pdf", html: "text/html", htm: "text/html",
  txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8",
  c: "text/plain; charset=utf-8", h: "text/plain; charset=utf-8", tex: "text/plain; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
};

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const course = sp.get("course");
  const p = (sp.get("p") ?? "").replace(/^\/+/, "").split("#")[0]; // jamais de fragment côté serveur
  if (!p || p.includes("..")) return new NextResponse("Bad path", { status: 400 });

  const cp = coursePaths(course);
  const base = p.startsWith("refs/") ? cp.refsDir : cp.contentRoot;
  const rel = p.startsWith("refs/") ? p.slice("refs/".length) : p;
  const abs = path.resolve(base, rel);
  const allowed = [cp.refsDir, cp.contentRoot].map((d) => path.resolve(d) + path.sep);
  if (!allowed.some((a) => abs.startsWith(a)) || !fs.existsSync(abs) || !fs.statSync(abs).isFile())
    return new NextResponse("Not found", { status: 404 });

  const ext = abs.split(".").pop()?.toLowerCase() ?? "";
  const buf = fs.readFileSync(abs);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "content-disposition": "inline",
      "cache-control": "private, max-age=3600",
    },
  });
}
