import { servedFileHeaders } from "@/lib/security-headers";
import { requireCourse } from "@/lib/req";
import { storage } from "@/lib/storage";
import { currentUser } from "@/db/context";
import { serveCounted } from "@/lib/served-bytes";
import { localPreviewUrl } from "@/lib/originals/registry";
import { resolveSourceFile } from "@/lib/source-files";
import { requestLocale } from "@/lib/i18n/api-error";
import { translator } from "@/lib/i18n/translate";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Service de fichier SOURCE, course-aware, pour le deep-link clic→source de la recherche.
 *   /csrc?course=<id>&p=<chemin relatif>#page=N
 * Résout `p` sous le cours : `refs/<f>` → refsDir ; sinon → contentRoot (le PDF s'ouvre à la
 * page via le fragment #page=N, géré par le viewer du navigateur — non vu par le serveur).
 * Sécurité : le chemin résolu DOIT rester sous refsDir ou contentRoot du cours (lib/source-files).
 */
const MIME: Record<string, string> = {
  pdf: "application/pdf", html: "text/html", htm: "text/html",
  txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8",
  c: "text/plain; charset=utf-8", h: "text/plain; charset=utf-8", tex: "text/plain; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
};

export async function GET(req: NextRequest) {
  // Garde d'APPARTENANCE : ce service lit dans refs/ et content/ du cours, qui
  // sont rangés sous le propriétaire pour un cours créé depuis l'interface.
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  const sp = req.nextUrl.searchParams;
  const p = (sp.get("p") ?? "").replace(/^\/+/, "").split("#")[0]; // jamais de fragment côté serveur
  if (!p || p.includes("..")) return new NextResponse("Bad path", { status: 400 });

  // Cours VALIDÉ par la garde, jamais le paramètre d'URL relu à part.
  const abs = await resolveSourceFile(course, p);
  if (!abs) {
    // Original resté sur l'ordinateur d'un compte gratuit (lib/originals) : la page qui l'ouvre
    // en local. Le fragment #page=N suit la redirection (le navigateur le garde).
    const local = await localPreviewUrl(course, p);
    if (local) return new NextResponse(null, { status: 302, headers: { location: local, "cache-control": "private, no-store" } });
    return missingOriginal(req, course);
  }

  // Aperçu d'une page (#page=N) : le PDF est diffusé par plages (ou depuis une
  // URL présignée du seau), jamais lu en entier en mémoire.
  const ext = abs.split(".").pop()?.toLowerCase() ?? "";
  // Relayé par le serveur : borné par compte et par jour (audit fuites I6).
  const res = await serveCounted(currentUser(), () => storage().serve(abs, req, {
    contentType: MIME[ext] ?? "application/octet-stream",
    headers: servedFileHeaders(MIME[ext] ?? "application/octet-stream", {
      "content-disposition": "inline",
      "cache-control": "private, max-age=3600",
    }),
  }));
  return res ?? new NextResponse("Not found", { status: 404 });
}

const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Source indexée dont le fichier n'existe plus (cours migré, original jamais copié) : un « Voir »
 * ouvert dans un onglet tombait sur un « Not found » en texte brut. Une navigation reçoit une page
 * qui dit quoi faire ; un appel de script garde la réponse courte.
 */
function missingOriginal(req: NextRequest, course: string): NextResponse {
  const wantsPage = req.headers.get("sec-fetch-dest") === "document" || /text\/html/.test(req.headers.get("accept") ?? "");
  if (!wantsPage) return new NextResponse("Not found", { status: 404 });
  const locale = requestLocale(req);
  const t = translator(locale);
  const back = `/sources?course=${encodeURIComponent(course)}`;
  // i18n-allow: gabarit HTML et CSS seulement ; les textes viennent de sourceViewer.*
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t("sourceViewer.missingTitle"))}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#f4f5f8;font:15px/1.55 -apple-system,system-ui,sans-serif;padding:24px;box-sizing:border-box}main{max-width:460px;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.03);border-radius:16px;padding:28px}h1{font-size:18px;margin:0 0 8px}p{color:#bfc1c9;margin:0 0 20px}a{display:inline-block;background:#f4f5f8;color:#0b0d12;border-radius:999px;padding:8px 16px;text-decoration:none;font-weight:600;font-size:14px}</style></head>
<body><main><h1>${esc(t("sourceViewer.missingTitle"))}</h1><p>${esc(t("sourceViewer.missingBody"))}</p><a href="${esc(back)}">${esc(t("sourceViewer.back"))}</a></main></body></html>`;
  return new NextResponse(html, { status: 404, headers: servedFileHeaders("text/html; charset=utf-8", { "cache-control": "private, no-store" }) });
}
