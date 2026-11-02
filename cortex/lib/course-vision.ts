import { currentCourse } from "@/db/client";
import { coursePaths, DEFAULT_COURSE } from "@/lib/courses";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Ancrage VISION par cours — généralise à tous les cours ce qui a fait la
 * qualité de cs-202 : rendre les pages des examens de référence en images, et les passer au
 * générateur ET au vérificateur (« voici comment le prof pose CE type ; produis du neuf du même
 * niveau »). cs-202 garde son `lib/figrefs.ts` curé ; les AUTRES cours utilisent ce module.
 *
 * Les images sont rendues depuis les PDF de `data/<course>/refs/` vers `…/refs/figref/`.
 */

function figrefDirFor(course: string): string {
  return path.join(coursePaths(course).refsDir, "figref");
}

/** PDF dont une image rendue vient (« final2024-sol-2.png » → « final2024-sol »), ou null. */
function imageBase(file: string): string | null {
  return /^(.*)-\d+\.(?:png|jpe?g)$/i.exec(file)?.[1] ?? null;
}

/** Chemin relatif au cwd (ce que l'outil Read du provider CLI attend). */
function relToCwd(abs: string): string {
  return path.relative(process.cwd(), abs);
}

/** Un binaire pdftoppm est-il disponible ? */
function pdftoppm(): string | null {
  for (const bin of ["pdftoppm", "/usr/bin/pdftoppm", "/opt/homebrew/bin/pdftoppm", "/usr/local/bin/pdftoppm"]) {
    try {
      execFileSync(bin, ["-v"], { stdio: "ignore" });
      return bin;
    } catch {
      // -v renvoie un code non-zéro sur certaines versions mais le binaire existe → tester existence
      if (bin.includes("/") && fs.existsSync(bin)) return bin;
    }
  }
  return null;
}

/**
 * Rend les premières pages de chaque PDF de référence du cours en PNG (étalon vision).
 * Idempotent (saute un PDF déjà rendu). Retourne le nombre d'images produites.
 * No-op pour cs-202 (il a ses figrefs curés) et si pdftoppm absent.
 */
export function renderCourseRefImages(course: string, pagesPerRef = 3): number {
  if (course === DEFAULT_COURSE) return 0;
  const refsDir = coursePaths(course).refsDir;
  if (!fs.existsSync(refsDir)) return 0;
  const bin = pdftoppm();
  if (!bin) return 0;
  const outDir = figrefDirFor(course);
  fs.mkdirSync(outDir, { recursive: true });
  let made = 0;
  for (const f of fs.readdirSync(refsDir)) {
    if (!/\.pdf$/i.test(f)) continue;
    const base = f.replace(/\.pdf$/i, "");
    const already = fs.readdirSync(outDir).some((x) => imageBase(x) === base);
    if (already) continue;
    try {
      execFileSync(bin, ["-png", "-r", "110", "-f", "1", "-l", String(pagesPerRef), path.join(refsDir, f), path.join(outDir, base)], { stdio: "ignore" });
      made += fs.readdirSync(outDir).filter((x) => imageBase(x) === base).length;
    } catch {
      /* PDF illisible → on saute */
    }
  }
  return made;
}

/**
 * Images-étalon disponibles pour le cours courant (chemins relatifs au cwd), triées. Seulement
 * celles d'une annale encore présente : retirer une annale (grille d'évaluation de HUM-285,
 * reclassée en consignes) laisse ses images sur le disque, jamais dans un prompt.
 */
export function courseRefImages(): string[] {
  const course = currentCourse();
  const dir = figrefDirFor(course);
  if (!fs.existsSync(dir)) return [];
  const refs = new Set(fs.readdirSync(coursePaths(course).refsDir).filter((f) => /\.pdf$/i.test(f)).map((f) => f.replace(/\.pdf$/i, "")));
  return fs
    .readdirSync(dir)
    .filter((x) => refs.has(imageBase(x) ?? ""))
    .sort()
    .map((x) => relToCwd(path.join(dir, x)));
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
