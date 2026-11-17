import { createHash } from "node:crypto";
import path from "node:path";
import { currentCourse } from "@/db/client";
import { currentUser } from "@/db/context";
import { nowStr } from "@/db/q";
import { coursePaths, getCourse } from "@/lib/courses";
import { log } from "@/lib/metrics";
import { purgePdfPages } from "@/lib/page-cache";
import { originalsPolicy, type OriginalsHome } from "@/lib/originals/policy";
import { forgetOriginal, isIndexed, localOriginal, localOriginals, markLocal, recordTransit, type OriginalOrigin } from "@/lib/originals/registry";
import { storage } from "@/lib/storage";

/**
 * ARRIVÉE ET DÉPART D'UN ORIGINAL — le seul endroit qui décide où un fichier déposé est écrit.
 *
 * Premium (lib/originals/policy) : exactement comme avant, le fichier est rangé dans le cours et
 * part au seau. Gratuit : le fichier est écrit en TRANSIT (disque du conteneur, jamais le seau)
 * et inscrit au registre ; il part après son indexation :
 *  - un support (cours, série, notes, annale Word/HTML/texte) dès que l'ingestion a lu son texte ;
 *  - une annale PDF à la fin de la préparation du cours, qui lit ses pages en image (format,
 *    index exercice par exercice) ;
 *  - dans tous les cas FREE_TRANSIT_HOURS heures après son arrivée au plus (défaut 24 ; 0 = dès
 *    la lecture du texte, annales comprises), par le balayage de lib/originals/retention.
 * Un compte devenu Premium pendant le transit : l'original part au cloud au lieu d'être supprimé.
 * Les cours historiques (contenu du dépôt) ne sont jamais concernés.
 */

export type StoredOriginal = { name: string; duplicate: boolean; home: OriginalsHome; restored: boolean };

export const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const HOUR_MS = 3600_000;

/** Où vont les originaux de ce cours : un cours historique (contenu du dépôt) reste dans le cloud. */
export async function originalsHomeFor(courseId: string, userId: string = currentUser()): Promise<OriginalsHome> {
  if (getCourse(courseId).paths) return "cloud";
  return (await originalsPolicy(userId)).home;
}

/** Heures de transit au plus (FREE_TRANSIT_HOURS, défaut 24 ; 0 = dès la lecture du texte). */
export function transitHours(env: Partial<NodeJS.ProcessEnv> = process.env): number {
  const raw = env.FREE_TRANSIT_HOURS?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 24 * 7) : 24;
}

/** Une annale PDF : la préparation lit ses pages en image, son original attend la fin de la préparation. */
export const needsPages = (coursePath: string) => coursePath.startsWith("refs/") && /\.pdf$/i.test(coursePath);

/**
 * Chemin d'un fichier dans le cours, celui de `sources.path` : `refs/<f>` ou `<dossier>/…/<f>` sous
 * le contenu ; `uploads/<f>` pour une pièce jointe (photo de copie, capture d'une faiblesse).
 */
export function coursePathOf(courseId: string, abs: string): string | null {
  const { refsDir, contentRoot, uploadsDir } = coursePaths(courseId);
  const under = (dir: string) => {
    const rel = path.relative(path.resolve(dir), path.resolve(abs));
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : null;
  };
  const flat = (dir: string, prefix: string) => {
    const rel = under(dir);
    return rel === null ? undefined : rel.includes("/") ? null : `${prefix}/${rel}`;
  };
  const inRefs = flat(refsDir, "refs");
  if (inRefs !== undefined) return inRefs;
  const inUploads = flat(uploadsDir, "uploads");
  if (inUploads !== undefined) return inUploads;
  return under(contentRoot);
}

/** Chemin absolu d'un chemin du cours (inverse de coursePathOf), ou null s'il sortirait du cours. */
export function absoluteOf(courseId: string, coursePath: string): string | null {
  const { refsDir, contentRoot, uploadsDir } = coursePaths(courseId);
  for (const [prefix, dir] of [["refs/", refsDir], ["uploads/", uploadsDir]] as const) {
    if (!coursePath.startsWith(prefix)) continue;
    const f = coursePath.slice(prefix.length);
    return f && !f.includes("/") && f !== ".." ? path.join(dir, f) : null;
  }
  const root = path.resolve(contentRoot);
  const abs = path.resolve(root, coursePath);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/**
 * Range `data` dans `dir` sous `name` (`nom-2`, `nom-3`… si le nom est pris), dans le cloud ou en
 * transit selon le compte. `dedupe` : un contenu identique déjà rangé sous ce nom n'est pas écrit
 * de nouveau (son nom est rendu, `duplicate`). Un nom pris par un original resté sur l'ordinateur
 * reste pris ; s'il s'agit du même fichier (même empreinte), il revient : `restored`. null : trop de
 * fichiers du même nom, ou nom qui sortirait du dossier.
 */
export async function storeOriginal(
  courseId: string, dir: string, name: string, data: Buffer,
  meta: {
    originalName?: string; rel?: string | null; origin?: OriginalOrigin; url?: string | null; dedupe?: boolean;
    /** Numérotation des noms pris : `nom-2`… jusqu'à 50 essais par défaut (storeUnique). */
    firstSuffix?: number; maxTries?: number;
  } = {},
): Promise<StoredOriginal | null> {
  const home = await originalsHomeFor(courseId);
  const root = path.resolve(dir);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const digest = sha256(data);
  const dedupe = meta.dedupe ?? true;
  const first = meta.firstSuffix ?? 2;
  const tries = meta.maxTries ?? 50;
  for (let i = 0; i < tries; i++) {
    const candidate = i === 0 ? name : `${stem}-${first + i - 1}${ext}`;
    const abs = path.join(root, candidate);
    if (!abs.startsWith(root + path.sep)) return null;
    const coursePath = coursePathOf(courseId, abs);
    const known = coursePath ? await localOriginal(coursePath) : null;
    if (known && known.state === "local" && !(await storage().stat(abs))) {
      if (known.sha256 !== digest) continue;
      await bringBack(abs, data, home, known.path);
      return { name: candidate, duplicate: true, home, restored: true };
    }
    if (await storage().put(abs, data, { exclusive: true, localOnly: home === "local" })) {
      if (home === "local" && coursePath) {
        await recordTransit({
          path: coursePath, name: meta.originalName ?? name, rel: meta.rel ?? null, sha256: digest, size: data.length,
          origin: meta.origin ?? "upload", url: meta.url ?? null,
        });
      }
      return { name: candidate, duplicate: false, home, restored: false };
    }
    if (!dedupe) continue;
    const existing = await storage().read(abs);
    if (existing && sha256(existing) === digest) return { name: candidate, duplicate: true, home, restored: false };
  }
  return null;
}

/**
 * Pièce jointe d'un exercice (photo de copie, capture d'une faiblesse) : rangée comme avant pour un
 * compte Premium ; pour un gratuit, en transit, le temps que le modèle la lise, puis supprimée par
 * le balayage (FREE_TRANSIT_HOURS). Cours historique (celui du propriétaire) : comme avant.
 */
export async function putUpload(courseId: string, abs: string, data: Uint8Array): Promise<void> {
  const home = await originalsHomeFor(courseId);
  await storage().put(abs, data, { localOnly: home === "local" });
  const coursePath = home === "local" ? coursePathOf(courseId, abs) : null;
  if (coursePath) {
    await recordTransit({ path: coursePath, name: path.basename(abs), sha256: sha256(Buffer.from(data)), size: data.byteLength, origin: "upload" });
  }
}

/** L'original d'un fichier resté sur l'ordinateur revient : au cloud (Premium) ou en transit (gratuit). */
async function bringBack(abs: string, data: Buffer, home: OriginalsHome, coursePath: string): Promise<void> {
  if (home === "cloud") {
    await storage().put(abs, data);
    await forgetOriginal(coursePath);
    return;
  }
  await storage().put(abs, data, { localOnly: true });
  const row = await localOriginal(coursePath);
  if (row) await recordTransit({ ...row, rel: row.rel });
}

/**
 * Renvoie un original depuis l'ordinateur (Premium : vers le cloud ; gratuit : en transit, pour une
 * préparation qui relit les pages). L'empreinte doit être celle du registre : sinon ce n'est pas
 * le même fichier, et l'index du cours n'en vient pas.
 */
export async function returnOriginal(courseId: string, coursePath: string, data: Buffer): Promise<{ ok: true; home: OriginalsHome } | { ok: false; status: number; error: string }> {
  const row = await localOriginal(coursePath);
  if (!row) return { ok: false, status: 404, error: "Ce fichier n'est pas un original resté sur ton ordinateur." };
  if (sha256(data) !== row.sha256) {
    return { ok: false, status: 409, error: `Ce n'est pas le même fichier que « ${row.name} » (contenu différent) : dépose-le comme un nouveau support.` };
  }
  const abs = absoluteOf(courseId, coursePath);
  if (!abs) return { ok: false, status: 400, error: "Chemin invalide." };
  const home = await originalsHomeFor(courseId);
  await bringBack(abs, data, home, coursePath);
  return { ok: true, home };
}

/** Retire un fichier déposé qui ne sert à rien (illisible) : du serveur et du registre. */
export async function discardOriginal(courseId: string, abs: string): Promise<void> {
  await storage().remove(abs);
  const coursePath = coursePathOf(courseId, abs);
  if (coursePath) await forgetOriginal(coursePath);
}

/**
 * Originaux arrivés en transit pendant une ingestion qui ne les a pas lus (arrivés depuis `since`,
 * absents de `read` et du corpus) : une ingestion de plus les lira, sinon ils partiraient sans index.
 */
export async function pendingTransit(since: string, read: Set<string> = new Set()): Promise<number> {
  const rows = (await localOriginals("transit")).filter((r) => r.arrivedAt >= since && !read.has(r.path));
  if (!rows.length) return 0;
  let n = 0;
  for (const r of rows) if (!(await isIndexed(r.path))) n++;
  return n;
}

/**
 * Départ des originaux en transit du cours courant, après une étape :
 *  - `ingest`  : ceux que cette ingestion a lus (`paths`), sauf les annales PDF (pages à lire) ;
 *  - `prepare` : tous ceux déjà indexés (la préparation a lu les pages) ;
 *  - `expiry`  : ceux arrivés depuis plus de FREE_TRANSIT_HOURS.
 * Indexé → supprimé du serveur, gardé au registre (`local`) ; jamais indexé → supprimé et oublié
 * (il ne comptait nulle part). Compte devenu Premium : l'original part au cloud.
 */
export async function settleOriginals(opts: { after: "ingest" | "prepare" | "expiry"; paths?: Iterable<string>; now?: string }): Promise<{ purged: number; promoted: number; dropped: number }> {
  const out = { purged: 0, promoted: 0, dropped: 0 };
  const transit = await localOriginals("transit");
  if (!transit.length) return out;
  const courseId = currentCourse();
  const wanted = opts.paths ? new Set(opts.paths) : null;
  const policy = getCourse(courseId).paths ? null : await originalsPolicy(currentUser());
  // Règle illisible (base des comptes indisponible) : rien ne bouge, ni suppression ni envoi au cloud.
  if (policy?.reason === "unknown") return out;
  const home: OriginalsHome = policy?.home ?? "cloud";
  const now = Date.parse(`${(opts.now ?? nowStr()).replace(" ", "T")}Z`);
  const ttlMs = transitHours() * HOUR_MS;
  for (const row of transit) {
    if (wanted && !wanted.has(row.path)) continue;
    // Une pièce jointe sert à un exercice en cours : elle ne part qu'à l'échéance du transit.
    const attachment = row.path.startsWith("uploads/");
    if (attachment && opts.after !== "expiry") continue;
    const abs = absoluteOf(courseId, row.path);
    if (!abs) { await forgetOriginal(row.path); continue; }
    const arrived = Date.parse(`${row.arrivedAt.replace(" ", "T")}Z`);
    const expired = !Number.isFinite(arrived) || now - arrived >= ttlMs;
    if (home === "cloud" && !attachment) {
      // Devenu Premium pendant le transit : l'original rejoint le cloud au lieu d'être supprimé.
      const data = await storage().read(abs);
      if (data) {
        await storage().put(abs, data);
        await forgetOriginal(row.path);
        out.promoted++;
      }
      continue;
    }
    if (opts.after === "expiry" && !expired) continue;
    if (opts.after === "ingest" && needsPages(row.path) && !expired) continue;
    const indexed = await isIndexed(row.path);
    // Arrivé pendant le job, pas encore lu (seule une ingestion qui l'a lu peut le déclarer illisible) :
    // il attend la prochaine ingestion, ou l'échéance.
    if (!indexed && !expired && !(opts.after === "ingest" && wanted)) continue;
    await storage().remove(abs);
    // Les pages rendues d'une annale en sont une copie : elles partent avec elle.
    if (row.path.startsWith("refs/")) purgePdfPages(courseId, path.basename(abs));
    if (indexed) {
      await markLocal(row.path);
      out.purged++;
    } else {
      await forgetOriginal(row.path);
      out.dropped++;
      if (!attachment) log("warn", "originals.dropped_unindexed", { course: courseId, path: row.path, after: opts.after });
    }
  }
  return out;
}
