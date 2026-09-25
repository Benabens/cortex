import { coursePaths } from "@/lib/courses";
import { servedFileHeaders } from "@/lib/security-headers";
import { useCourseOr404 } from "@/lib/req";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Service de fichier SOURCE, course-aware, pour le deep-link clic→source de la recherche.
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

/**
 * Repli anti-404 : si le chemin stocké ne résout pas (vieille ingestion, préfixe périmé
 * `lectures/` → `slides/`), on cherche le fichier par son BASENAME dans les dossiers du cours
 * (refs/ d'abord, puis content/**). Jamais de cul-de-sac silencieux quand le fichier existe ailleurs.
 * Walk borné : on saute les dossiers lourds/inutiles et on plafonne le nombre de fichiers scannés.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "figref", "img", "images"]);
function findByBasename(roots: string[], basename: string): string | null {
  const target = basename.toLowerCase();
  let scanned = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(abs); continue; }
        if (++scanned > 4000) return null; // garde-fou : ne walk jamais indéfiniment
        if (e.name.toLowerCase() === target) return abs;
      }
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  // Garde d'APPARTENANCE : ce service lit dans refs/ et content/ du cours, qui
  // sont rangés sous le propriétaire pour un cours créé depuis l'interface.
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const sp = req.nextUrl.searchParams;
  const course = sp.get("course");
  const p = (sp.get("p") ?? "").replace(/^\/+/, "").split("#")[0]; // jamais de fragment côté serveur
  if (!p || p.includes("..")) return new NextResponse("Bad path", { status: 400 });

  const cp = coursePaths(course);
  const base = p.startsWith("refs/") ? cp.refsDir : cp.contentRoot;
  const rel = p.startsWith("refs/") ? p.slice("refs/".length) : p;
  const allowed = [cp.refsDir, cp.contentRoot].map((d) => path.resolve(d) + path.sep);
  let abs = path.resolve(base, rel);
  const ok = (a: string) => allowed.some((d) => a.startsWith(d)) && fs.existsSync(a) && fs.statSync(a).isFile();

  if (!ok(abs)) {
    // repli par basename : le fichier a peut-être bougé (slides/ vs lectures/) → on le retrouve.
    const found = findByBasename([cp.refsDir, cp.contentRoot], path.basename(rel));
    if (found && ok(found)) abs = found;
    else return new NextResponse("Not found", { status: 404 });
  }

  const ext = abs.split(".").pop()?.toLowerCase() ?? "";
  const buf = fs.readFileSync(abs);
  return new NextResponse(new Uint8Array(buf), {
    headers: servedFileHeaders(MIME[ext] ?? "application/octet-stream", {
      "content-disposition": "inline",
      "cache-control": "private, max-age=3600",
    }),
  });
}
