import { coursePaths } from "@/lib/courses";
import { servedFileHeaders } from "@/lib/security-headers";
import { requireCourse } from "@/lib/req";
import { storage } from "@/lib/storage";
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
 * Parcours borné : on saute les dossiers lourds/inutiles et on plafonne le nombre de fichiers examinés.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "figref", "img", "images"]);
async function findByBasename(roots: string[], basename: string): Promise<string | null> {
  const target = basename.toLowerCase();
  let scanned = 0;
  for (const root of roots) {
    for (const f of await storage().list(root)) {
      const segs = path.relative(root, f.path).split(path.sep);
      if (segs.some((x) => x.startsWith(".")) || segs.slice(0, -1).some((x) => SKIP_DIRS.has(x))) continue;
      if (++scanned > 4000) return null; // garde-fou : ne parcourt jamais indéfiniment
      if (segs[segs.length - 1].toLowerCase() === target) return f.path;
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  // Garde d'APPARTENANCE : ce service lit dans refs/ et content/ du cours, qui
  // sont rangés sous le propriétaire pour un cours créé depuis l'interface.
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  const sp = req.nextUrl.searchParams;
  const p = (sp.get("p") ?? "").replace(/^\/+/, "").split("#")[0]; // jamais de fragment côté serveur
  if (!p || p.includes("..")) return new NextResponse("Bad path", { status: 400 });

  // Cours VALIDÉ par la garde, jamais le paramètre d'URL relu à part.
  const cp = coursePaths(course);
  const base = p.startsWith("refs/") ? cp.refsDir : cp.contentRoot;
  const rel = p.startsWith("refs/") ? p.slice("refs/".length) : p;
  const allowed = [cp.refsDir, cp.contentRoot].map((d) => path.resolve(d) + path.sep);
  let abs = path.resolve(base, rel);
  const ok = async (a: string) => allowed.some((d) => a.startsWith(d)) && !!(await storage().stat(a));

  if (!(await ok(abs))) {
    // repli par basename : le fichier a peut-être bougé (slides/ vs lectures/) → on le retrouve.
    const found = await findByBasename([cp.refsDir, cp.contentRoot], path.basename(rel));
    if (found && (await ok(found))) abs = found;
    else return new NextResponse("Not found", { status: 404 });
  }

  // Aperçu d'une page (#page=N) : le PDF est diffusé par plages (ou depuis une
  // URL présignée du seau), jamais lu en entier en mémoire.
  const ext = abs.split(".").pop()?.toLowerCase() ?? "";
  const res = await storage().serve(abs, req, {
    contentType: MIME[ext] ?? "application/octet-stream",
    headers: servedFileHeaders(MIME[ext] ?? "application/octet-stream", {
      "content-disposition": "inline",
      "cache-control": "private, max-age=3600",
    }),
  });
  return res ?? new NextResponse("Not found", { status: 404 });
}
