import { createHash } from "node:crypto";
import path from "node:path";
import { coursePaths } from "@/lib/courses";
import { storage } from "@/lib/storage";

/**
 * Où vit le fichier d'une source (`sources.path`) : la même résolution pour /csrc, qui le sert,
 * et pour la liste des sources, qui ne montre « Voir » que s'il existe. Un cours migré du
 * mono-user a des sources indexées dont l'original n'a jamais été copié : sans ce contrôle,
 * chaque « Voir » menait à un « Not found » brut.
 *
 * `p` sous `refs/` → refsDir du cours ; sinon → contentRoot. Repli anti-404 : si le chemin stocké
 * ne résout pas (vieille ingestion, préfixe périmé `lectures/` → `slides/`), le fichier est
 * cherché par son BASENAME (refs/ d'abord, puis content/**). Parcours borné : on saute les
 * dossiers cachés et d'images, et l'on plafonne le nombre de fichiers examinés.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "figref", "img", "images"]);
const SCAN_CAP = 4000;

type CourseDirs = { refsDir: string; contentRoot: string };

function baseAndRel(cp: CourseDirs, p: string): { abs: string; rel: string } {
  const base = p.startsWith("refs/") ? cp.refsDir : cp.contentRoot;
  const rel = p.startsWith("refs/") ? p.slice("refs/".length) : p;
  return { abs: path.resolve(base, rel), rel };
}

function allowedRoots(cp: CourseDirs): string[] {
  return [cp.refsDir, cp.contentRoot].map((d) => path.resolve(d) + path.sep);
}

/**
 * Le stockage du cours en un parcours : `all` (pour la correspondance exacte du chemin) et
 * `candidates`, les fichiers du repli par basename dans l'ordre de recherche (refs/ d'abord) ;
 * `candidates` s'arrête au plafond (`capped`) : le repli n'examine jamais plus de SCAN_CAP fichiers.
 */
async function scan(cp: CourseDirs): Promise<{ all: string[]; candidates: string[]; capped: boolean }> {
  const all: string[] = [];
  const candidates: string[] = [];
  let capped = false;
  for (const root of [cp.refsDir, cp.contentRoot]) {
    for (const f of await storage().list(root)) {
      all.push(f.path);
      const segs = path.relative(root, f.path).split(path.sep);
      if (segs.some((x) => x.startsWith(".")) || segs.slice(0, -1).some((x) => SKIP_DIRS.has(x))) continue;
      if (candidates.length >= SCAN_CAP) capped = true;
      else candidates.push(f.path);
    }
  }
  return { all, candidates, capped };
}

/** Chemin absolu du fichier de la source `p` du cours, ou null s'il n'existe nulle part. */
export async function resolveSourceFile(course: string, p: string): Promise<string | null> {
  const cp = coursePaths(course);
  const allowed = allowedRoots(cp);
  const ok = async (a: string) => allowed.some((d) => a.startsWith(d)) && !!(await storage().stat(a));
  const { abs, rel } = baseAndRel(cp, p);
  if (await ok(abs)) return abs;
  const target = path.basename(rel).toLowerCase();
  const found = (await scan(cp)).candidates.find((f) => path.basename(f).toLowerCase() === target);
  return found && (await ok(found)) ? found : null;
}

/**
 * Pour une liste de sources d'un cours : celles dont le fichier existe (même règle que
 * resolveSourceFile, en UN parcours du stockage au lieu d'un par source). null = on ne sait pas
 * (stockage illisible ou cours trop gros pour le parcours borné) : l'appelant garde alors ses liens.
 */
export async function existingSourcePaths(course: string, paths: string[]): Promise<Set<string> | null> {
  const cp = coursePaths(course);
  // Un parcours du stockage coûte 0,3 à 0,7 s en production (seau S3) : gardé quelques minutes,
  // pour CE cours et CETTE liste de sources (un import ou un retrait change la clé).
  const key = createHash("sha1").update(cp.refsDir + "\n" + cp.contentRoot + "\n" + paths.join("\n")).digest("hex");
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - CACHE_MS) return hit.value;
  const value = await existingNow(cp, paths);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
  return value;
}

const CACHE_MS = 5 * 60_000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; value: Set<string> | null }>();

async function existingNow(cp: CourseDirs, paths: string[]): Promise<Set<string> | null> {
  let listing: Awaited<ReturnType<typeof scan>>;
  try { listing = await scan(cp); } catch { return null; }
  if (listing.capped) return null;
  const allowed = allowedRoots(cp);
  const present = new Set(listing.all);
  const basenames = new Set(listing.candidates.map((f) => path.basename(f).toLowerCase()));
  const out = new Set<string>();
  for (const p of paths) {
    const { abs, rel } = baseAndRel(cp, p);
    const inside = allowed.some((d) => abs.startsWith(d));
    if ((inside && present.has(abs)) || basenames.has(path.basename(rel).toLowerCase())) out.add(p);
  }
  return out;
}
