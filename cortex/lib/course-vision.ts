import { currentCourse } from "@/db/client";
import { coursePaths, DEFAULT_COURSE } from "@/lib/courses";
import { withoutSolutions } from "@/lib/exam-names";
import { cachedPdfPages, pageCacheDirFor } from "@/lib/page-cache";
import fs from "node:fs";
import path from "node:path";

/**
 * Ancrage VISION par cours — généralise à tous les cours ce qui a fait la
 * qualité de cs-202 : rendre les pages des examens de référence en images, et les passer au
 * générateur ET au vérificateur (« voici comment le prof pose CE type ; produis du neuf du même
 * niveau »). cs-202 garde son `lib/figrefs.ts` curé ; les AUTRES cours utilisent ce module.
 *
 * Les pages des PDF de `refs/` sont rendues dans le cache des pages (lib/page-cache) ; le
 * dossier `refs/figref/` ne garde que les images posées à la main (et celles, curées, de cs-202).
 */

/** Pages de chaque annale montrées au modèle comme étalon. */
const VISION_PAGES = 3;

function figrefDirFor(course: string): string {
  return path.join(coursePaths(course).refsDir, "figref");
}

/** Annale (PDF de refs/) dont une image rendue vient (« final2024-sol-2.png » → « final2024-sol »), ou null. */
function sourcePdfOf(file: string): string | null {
  // pdftoppm numérote les pages sur 1 à 3 chiffres (« -1 », « -01 ») ; « topo-2024.png » n'en vient pas.
  return /^(.*)-\d{1,3}\.(?:png|jpe?g)$/i.exec(file)?.[1] ?? null;
}

/** Chemin relatif au cwd (ce que l'outil Read du provider CLI attend). */
function relToCwd(abs: string): string {
  return path.relative(process.cwd(), abs);
}

/** PDF de référence du cours (dossier refs/), par nom de fichier ; les corrigés ne servent d'étalon que seuls. */
function refPdfs(course: string): string[] {
  try {
    return withoutSolutions(fs.readdirSync(coursePaths(course).refsDir).filter((f) => /\.pdf$/i.test(f)), (f) => f).sort();
  } catch { return []; }
}

/**
 * Rend les premières pages de chaque PDF de référence du cours en PNG (étalon vision), dans le
 * cache des pages (lib/page-cache : un seul rendu, partagé avec l'index des annales, hors quota).
 * Idempotent. Retourne le nombre d'images produites par cet appel.
 * No-op pour cs-202 (il a ses figrefs curés) et si pdftoppm absent.
 */
export function renderCourseRefImages(course: string, pagesPerRef = VISION_PAGES): number {
  if (course === DEFAULT_COURSE) return 0;
  const pngs = () => {
    try { return fs.readdirSync(pageCacheDirFor(course)).filter((x) => /\.png$/i.test(x)).length; } catch { return 0; }
  };
  const before = pngs();
  for (const f of refPdfs(course)) cachedPdfPages(course, f, pagesPerRef);
  return pngs() - before;
}

/**
 * Images-étalon disponibles pour le cours courant (chemins relatifs au cwd), triées :
 *  - les images posées à la main dans refs/figref (sans le suffixe « -N » du rendu), et pour le
 *    cours historique ses images curées ; un rendu d'une annale qui n'est plus là est écarté —
 *    retirer une annale (grille d'évaluation de HUM-285, reclassée en consignes) ne la laisse
 *    jamais dans un prompt ;
 *  - les premières pages de chaque annale, depuis le cache des pages, rendues à la demande si le
 *    cache a été purgé.
 */
export function courseRefImages(): string[] {
  const course = currentCourse();
  const out: string[] = [];
  // D'abord le cache : il retire au passage les rendus des anciennes versions de refs/figref.
  if (course !== DEFAULT_COURSE) {
    for (const f of refPdfs(course)) {
      for (const p of cachedPdfPages(course, f, VISION_PAGES)) out.push(relToCwd(p.abs));
    }
  }
  const dir = figrefDirFor(course);
  if (fs.existsSync(dir)) {
    const refs = new Set(refPdfs(course).map((f) => f.replace(/\.pdf$/i, "")));
    for (const x of fs.readdirSync(dir)) {
      const src = sourcePdfOf(x);
      if (/\.(png|jpe?g)$/i.test(x) && (src == null || refs.has(src))) out.push(relToCwd(path.join(dir, x)));
    }
  }
  return out.sort();
}

/**
 * Compte gratuit (lib/originals) : annales restées sur l'ordinateur, dont les pages ne se montrent
 * plus au modèle. null s'il n'y en a pas. Dit à l'étudiant sur quoi l'examen se cale.
 */
export async function offServerRefsNote(): Promise<string | null> {
  const { pathsOnComputer } = await import("@/lib/originals/index-only");
  const n = [...(await pathsOnComputer())].filter((p) => p.startsWith("refs/") && /\.pdf$/i.test(p)).length;
  if (!n) return null;
  return `${n} annale${n > 1 ? "s" : ""} sur ton ordinateur : l'examen se cale sur leur texte et leur index, sans revoir leurs pages en image.`;
}

/** Bloc d'ancrage vision pour le profil générique (vide s'il n'y a pas d'images). */
export function genericVisionBlock(): string {
  const imgs = courseRefImages();
  if (!imgs.length) return "";
  return [
    `═══ ANCRAGE VISUEL — REGARDE D'ABORD CES VRAIES PAGES D'EXAMEN (outil Read) ═══`,
    `Avant d'écrire, OUVRE et OBSERVE ces pages de vrais examens du cours. Calque la RICHESSE, la DENSITÉ, la DIFFICULTÉ et les PIÈGES sur ces exemplaires — produis du NEUF du même niveau, sans recopier :`,
    ...imgs.slice(0, 8).map((p) => `  - ${p}`),
    `Pour chaque exercice, identifie son TYPE et vise le niveau visuel + de difficulté de la page correspondante.`,
  ].join("\n");
}

/** Image-étalon pertinente pour un exo (match mots-clés sur le nom de fichier, sinon la 1ʳᵉ). */
export function genericRefImageFor(_category?: string, concept?: string): string | null {
  const imgs = courseRefImages();
  if (!imgs.length) return null;
  const c = (concept ?? "").toLowerCase();
  if (c) {
    const words = c.split(/\W+/).filter((w) => w.length >= 4);
    const hit = imgs.find((p) => words.some((w) => path.basename(p).toLowerCase().includes(w)));
    if (hit) return hit;
  }
  return imgs[0];
}
