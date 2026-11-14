import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { userSlug } from "@/db/context";
import { coursePaths, dataRoot, getCourse } from "@/lib/courses";
import { findPdftoppm, renderPdfPages } from "@/lib/pdftoppm";

/**
 * CACHE DES IMAGES DE PAGES (audit du 14/11/2026, 🟠 15).
 *
 * Les pages des annales rendues en PNG (ancrage vision, index des exercices,
 * révision) représentaient environ 69 % de `refs/` et comptaient dans le quota
 * du compte, sans jamais être purgées ; les pages 1 à 3 étaient rendues deux fois
 * (refs/figref pour la vision, refs/figref-full pour l'index).
 *
 * Elles vivent désormais dans `data/.page-cache/`, miroir du dossier refs du
 * cours (`.page-cache/u/<compte>/<cours>/refs/`) : hors du dossier du compte (donc
 * hors quota), hors sauvegarde (lib/backup), et PURGEABLE — tout ce qui manque est
 * rendu à nouveau à la demande. Une page n'est rendue qu'une fois, quel que soit
 * l'appelant. Le retrait d'une annale purge ses pages, la suppression d'un cours
 * ou d'un compte purge son cache.
 *
 * Nommage : `<base>-<n>.png`, base = nom du PDF sans extension, caractères hors
 * [a-zA-Z0-9._-] remplacés par « _ » ; si ce remplacement a changé le nom, un
 * court hachage du nom d'origine suit (« a b.pdf » et « a_b.pdf » ne partagent
 * jamais leurs pages). Les pages se cherchent en respectant la casse. Un marqueur `<base>.pages` retient jusqu'à
 * quelle page le PDF a été demandé : un PDF de 2 pages demandé jusqu'à 16 n'est
 * pas rendu à chaque appel.
 */

export const PAGE_CACHE_DIR = ".page-cache";

export function pageCacheRoot(): string {
  return path.join(dataRoot(), PAGE_CACHE_DIR);
}

/** « midterm.pdf » → « midterm » ; « final 2024.pdf » → « final_2024.<hachage> ». */
export function pageBase(pdfName: string): string {
  const raw = path.basename(pdfName).replace(/\.pdf$/i, "");
  const safe = sanitizedBase(pdfName);
  return safe === raw ? safe : `${safe}.${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
}

function sanitizedBase(pdfName: string): string {
  return path.basename(pdfName).replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/** Dossier du cache d'un cours : le miroir de son dossier refs sous data/.page-cache/. */
export function pageCacheDirFor(course: string): string {
  const refs = path.resolve(coursePaths(course).refsDir);
  const rel = path.relative(path.resolve(dataRoot()), refs);
  const inside = rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  return path.join(pageCacheRoot(), inside ? rel : path.join("ext", refs.replace(/[^a-zA-Z0-9._-]+/g, "_")));
}

/** Cache d'un cours possédé, sans dépendre du catalogue (cours en cours de suppression). */
export function ownedCourseCacheDir(userId: string, courseId: string): string {
  return path.join(pageCacheRoot(), "u", userSlug(userId), courseId);
}

/** Cache de tous les cours d'un compte. */
export function userCacheDir(userId: string): string {
  return path.join(pageCacheRoot(), "u", userSlug(userId));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function cachedPages(dir: string, base: string): { page: number; abs: string }[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const re = new RegExp(`^${escapeRe(base)}-(\\d{1,3})\\.png$`);
  return names
    .map((n) => ({ m: re.exec(n), n }))
    .filter((x): x is { m: RegExpExecArray; n: string } => !!x.m)
    .map((x) => ({ page: Number(x.m[1]), abs: path.join(dir, x.n) }))
    .filter((p) => p.page > 0)
    .sort((a, b) => a.page - b.page);
}

function requestedUpTo(dir: string, base: string): number {
  try { return Number(fs.readFileSync(path.join(dir, `${base}.pages`), "utf8")) || 0; } catch { return 0; }
}

/**
 * Rendus des anciennes versions, dans le dossier du COMPTE : refs/figref-full
 * (index, uniquement des rendus) et, dans refs/figref, les rendus « <pdf>-<n> »
 * d'un PDF présent. Retirés : ils comptaient dans le quota et se régénèrent. Une
 * image posée à la main (sans suffixe de page) reste. Seulement pour un cours
 * possédé (sous data/u/) : le cours historique partagé garde ses images curées.
 */
const migrated = new Set<string>();
function dropLegacyRenders(course: string): void {
  if (migrated.has(course)) return;
  migrated.add(course);
  if (getCourse(course).paths) return;
  const refsDir = coursePaths(course).refsDir;
  const full = path.join(refsDir, "figref-full");
  try {
    for (const f of fs.readdirSync(full)) if (/-\d{1,3}\.png$/i.test(f)) fs.rmSync(path.join(full, f), { force: true });
    if (!fs.readdirSync(full).length) fs.rmdirSync(full);
  } catch { /* absent */ }
  const vision = path.join(refsDir, "figref");
  let pdfs: Set<string>;
  try {
    pdfs = new Set(fs.readdirSync(refsDir).filter((f) => /\.pdf$/i.test(f)).flatMap((f) => [f.replace(/\.pdf$/i, ""), sanitizedBase(f)]));
  } catch { return; }
  try {
    for (const f of fs.readdirSync(vision)) {
      const src = /^(.*)-\d{1,3}\.(?:png|jpe?g)$/i.exec(f)?.[1];
      if (src && pdfs.has(src)) fs.rmSync(path.join(vision, f), { force: true });
    }
  } catch { /* absent */ }
}

/**
 * Pages 1 à `lastPage` d'un PDF du dossier refs du cours, rendues au plus une
 * fois dans le cache (seules les pages manquantes sont rendues). Rend les pages
 * présentes, triées ; [] sans PDF ni pdftoppm.
 */
export function cachedPdfPages(course: string, pdfName: string, lastPage: number): { page: number; abs: string }[] {
  const pdf = path.join(coursePaths(course).refsDir, path.basename(pdfName));
  if (!fs.existsSync(pdf)) return [];
  dropLegacyRenders(course);
  const dir = pageCacheDirFor(course);
  const base = pageBase(pdfName);
  let pages = cachedPages(dir, base);
  const done = Math.max(requestedUpTo(dir, base), pages.length ? pages[pages.length - 1].page : 0);
  if (done < lastPage) {
    const bin = findPdftoppm();
    if (bin) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        renderPdfPages(bin, pdf, path.join(dir, base), { firstPage: done + 1, lastPage });
        fs.writeFileSync(path.join(dir, `${base}.pages`), String(lastPage));
      } catch {
        // PDF illisible, ou première page demandée au-delà de la dernière : rien de plus à rendre.
        try { fs.writeFileSync(path.join(dir, `${base}.pages`), String(lastPage)); } catch { /* cache en lecture seule */ }
      }
      pages = cachedPages(dir, base);
    }
  }
  return pages.filter((p) => p.page <= lastPage);
}

/** Retire du cache les pages d'un PDF (annale retirée). */
export function purgePdfPages(course: string, pdfName: string): void {
  const dir = pageCacheDirFor(course);
  const base = pageBase(pdfName);
  for (const p of cachedPages(dir, base)) fs.rmSync(p.abs, { force: true });
  fs.rmSync(path.join(dir, `${base}.pages`), { force: true });
}

/** Vide tout le cache (volume presque plein) : tout se rend de nouveau à la demande. Rend les octets libérés. */
export function purgePageCache(): number {
  const root = pageCacheRoot();
  let bytes = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { try { bytes += fs.statSync(p).size; } catch { /* disparu */ } }
    }
  };
  walk(root);
  fs.rmSync(root, { recursive: true, force: true });
  return bytes;
}
