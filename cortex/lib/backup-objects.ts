/**
 * SAUVEGARDE DES OBJETS DU SEAU DE FICHIERS (lib/storage, STORAGE_S3_*).
 *
 * Le seau de fichiers (Railway Buckets) n'a ni versionnage ni corbeille, et
 * l'archive du volume ne contient plus les fichiers qui y vivent. La sauvegarde
 * quotidienne en garde donc une copie dans le stockage de sauvegarde (BACKUP_S3_*) :
 *
 *  - CONTENU par empreinte : `<BACKUP_S3_PREFIX>_objets/<sha[0:2]>/<sha256>`. Un
 *    contenu n'est envoyé qu'une fois, quel que soit le nombre de jours ou de
 *    clés qui le citent (copie incrémentale) ;
 *  - INDEX par sauvegarde : `objects.json` dans le dossier du jour, la liste
 *    clé → empreinte du seau à cet instant (couvert par le manifeste).
 *
 * Restaurer un jour = relire son index et rapatrier chaque contenu, empreinte
 * vérifiée. Un objet supprimé du seau disparaît des index suivants mais reste
 * dans ceux des jours retenus : il est restaurable tant que la rétention
 * (BACKUP_KEEP_DAYS, 14 j) garde une sauvegarde qui le cite. Ensuite, son
 * contenu n'est plus cité par aucun index et la rétention l'efface.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BackupS3Config, BackupStore, RemoteBackup } from "@/lib/backup-s3";
import { isNotFound, type ObjectBucket } from "@/lib/storage/bucket";
import { contentTypeOf } from "@/lib/storage/s3";

/** Dossier réservé du stockage de sauvegarde : jamais un dossier de sauvegarde. */
export const BLOBS_DIR = "_objets";
export const OBJECTS_FILE = "objects.json";

export type ObjectEntry = {
  /** Clé relative au préfixe du seau de fichiers (u/<compte>/<cours>/…). */
  key: string;
  size: number;
  sha256: string;
  /** LastModified de l'objet source (ISO) : un objet inchangé n'est pas relu. */
  lastModified: string;
};

export type ObjectIndex = { version: 1; objects: ObjectEntry[] };

/** Ce que le manifeste d'une sauvegarde dit de son index (fichier, volume, empreinte). */
export type ObjectIndexRef = { file: string; objects: number; bytes: number; sha256: string };

type Log = { log?: (msg: string) => void };

export const blobKey = (cfg: BackupS3Config, sha256: string) => `${cfg.prefix}${BLOBS_DIR}/${sha256.slice(0, 2)}/${sha256}`;

/** Télécharge un objet dans un temporaire en calculant son empreinte (jamais tout en mémoire). */
async function fetchHashed(source: ObjectBucket, key: string): Promise<{ file: string; size: number; sha256: string } | null> {
  const obj = await source.stream(key);
  if (!obj) return null; // supprimé entre le listage et la lecture
  const file = path.join(os.tmpdir(), `cortex-objbak-${randomBytes(6).toString("hex")}`);
  const hash = createHash("sha256");
  let size = 0;
  const tap = new Transform({ transform(chunk: Buffer, _e, cb) { hash.update(chunk); size += chunk.length; cb(null, chunk); } });
  try {
    await pipeline(obj.body, tap, fs.createWriteStream(file));
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  }
  return { file, size, sha256: hash.digest("hex") };
}

export type SnapshotOptions = Log & {
  /** Seau de fichiers (lu seulement). */
  source: ObjectBucket;
  /** Préfixe des fichiers dans ce seau (STORAGE_S3_PREFIX normalisé). */
  sourcePrefix: string;
  store: BackupStore;
  cfg: BackupS3Config;
  /** Index de la dernière sauvegarde : un objet de même taille et même date n'est pas relu. */
  previous?: ObjectIndex | null;
};

export type SnapshotResult = { index: ObjectIndex; downloaded: number; uploaded: number; bytesUploaded: number };

/** Copie dans le stockage de sauvegarde le contenu des objets du seau et rend l'index du jour. */
export async function snapshotObjects(opts: SnapshotOptions): Promise<SnapshotResult> {
  const log = opts.log ?? console.log;
  const blobs = new Set((await opts.store.list(`${opts.cfg.prefix}${BLOBS_DIR}/`)).map((o) => o.key));
  const objects: ObjectEntry[] = [];
  const out: SnapshotResult = { index: { version: 1, objects }, downloaded: 0, uploaded: 0, bytesUploaded: 0 };
  // Un marqueur de dossier (clé finissant par « / », posé par certaines consoles) n'est pas un fichier.
  const sources = (await opts.source.list(opts.sourcePrefix)).filter((o) => o.key.length > opts.sourcePrefix.length && !o.key.endsWith("/"));
  const known = new Map((opts.previous?.objects ?? []).map((e) => [e.key, e]));
  // Un contenu présent mais cité par aucune sauvegarde retenue est un orphelin ancien : le
  // réutiliser tel quel laisserait sa vieille date, et une purge concurrente l'effacerait
  // avant l'envoi de l'index du jour. Il est donc renvoyé (sa date repart).
  const cited = new Set((opts.previous?.objects ?? []).map((e) => blobKey(opts.cfg, e.sha256)));
  for (const o of sources.sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const key = o.key.slice(opts.sourcePrefix.length);
    const prev = known.get(key);
    if (prev && prev.size === o.size && prev.lastModified === o.lastModified.toISOString() && blobs.has(blobKey(opts.cfg, prev.sha256))) {
      objects.push(prev);
      continue;
    }
    const got = await fetchHashed(opts.source, o.key);
    if (!got) continue;
    out.downloaded++;
    try {
      const dest = blobKey(opts.cfg, got.sha256);
      if (!blobs.has(dest) || !cited.has(dest)) {
        await opts.store.put(dest, { path: got.file, size: got.size }, "application/octet-stream");
        blobs.add(dest);
        cited.add(dest); // une seconde clé de même contenu, dans ce passage, ne le renvoie pas
        out.uploaded++;
        out.bytesUploaded += got.size;
      }
    } finally {
      fs.rmSync(got.file, { force: true });
    }
    objects.push({ key, size: got.size, sha256: got.sha256, lastModified: o.lastModified.toISOString() });
  }
  log(`[backup:objets] ${objects.length} objet(s) du seau, ${out.downloaded} relu(s), ${out.uploaded} contenu(s) envoyé(s) (${(out.bytesUploaded / 1024 / 1024).toFixed(1)} Mo)`);
  return out;
}

export type RestoreObjectsOptions = Log & {
  store: BackupStore;
  cfg: BackupS3Config;
  index: ObjectIndex;
} & (
  /** Restaure dans ce dossier, sous la même arborescence (essai de restauration). */
  | { toDir: string; toBucket?: never }
  /** Restaure dans un seau de fichiers, sous son préfixe (sinistre). */
  | { toBucket: { bucket: ObjectBucket; prefix: string }; toDir?: never }
);

/** Rapatrie chaque objet de l'index, empreinte vérifiée. */
export async function restoreObjects(opts: RestoreObjectsOptions): Promise<{ restored: number; bytes: number }> {
  const log = opts.log ?? console.log;
  let restored = 0;
  let bytes = 0;
  for (const e of opts.index.objects) {
    const parts = e.key.split("/");
    if (parts.some((p) => p === "" || p === "." || p === "..")) throw new Error(`Index : clé invalide « ${e.key} »`);
    const body = await opts.store.get(blobKey(opts.cfg, e.sha256));
    if (createHash("sha256").update(body).digest("hex") !== e.sha256) {
      throw new Error(`Contenu altéré dans le stockage de sauvegarde : empreinte différente pour ${e.key}`);
    }
    if (opts.toBucket) {
      await opts.toBucket.bucket.put(opts.toBucket.prefix + e.key, body, contentTypeOf(e.key));
    } else {
      const dest = path.join(opts.toDir, ...parts);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
    }
    restored++;
    bytes += body.length;
  }
  log(`[backup:objets] ${restored} objet(s) restauré(s) (${(bytes / 1024 / 1024).toFixed(1)} Mo)`);
  return { restored, bytes };
}

/**
 * Chaque objet de l'index a-t-il son contenu dans le stockage de sauvegarde, de
 * la bonne taille ? (Sans tout relire : les empreintes sont vérifiées à la restauration.)
 */
export async function verifyRemoteObjects(opts: Log & { store: BackupStore; cfg: BackupS3Config; index: ObjectIndex }): Promise<{ objects: number; missing: string[] }> {
  const log = opts.log ?? console.log;
  const sizes = new Map((await opts.store.list(`${opts.cfg.prefix}${BLOBS_DIR}/`)).map((o) => [o.key, o.size]));
  const missing = opts.index.objects.filter((e) => sizes.get(blobKey(opts.cfg, e.sha256)) !== e.size).map((e) => e.key);
  log(`[backup:objets] ${opts.index.objects.length} objet(s) indexé(s)${missing.length ? `, ${missing.length} sans contenu valide : ${missing.slice(0, 5).join(", ")}` : ", contenus présents ✓"}`);
  return { objects: opts.index.objects.length, missing };
}

/** Index d'un dossier de sauvegarde local (rapatrié) ; null si la sauvegarde n'en porte pas. */
export function readLocalIndex(dir: string, ref: ObjectIndexRef | undefined): ObjectIndex | null {
  return ref ? (JSON.parse(fs.readFileSync(path.join(dir, ref.file), "utf8")) as ObjectIndex) : null;
}

/** Index d'une sauvegarde distante ; null si elle n'en a pas (pas de stockage objet ce jour-là). */
export async function readRemoteIndex(store: BackupStore, cfg: BackupS3Config, folder: string): Promise<ObjectIndex | null> {
  try {
    return JSON.parse((await store.get(`${cfg.prefix}${folder}/${OBJECTS_FILE}`)).toString("utf8")) as ObjectIndex;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * Délai avant qu'un contenu non cité soit effacé : celui d'une capture en cours,
 * envoyé avant que l'index du jour n'existe, n'est jamais pris pour un orphelin.
 */
const BLOB_GRACE_MS = 24 * 3_600_000;

/**
 * Efface les contenus qu'aucune des sauvegardes `remaining` (complètes ou non)
 * ne cite. Appelée par pruneBackups avec les dossiers qu'elle a gardés.
 */
export async function pruneBlobs(store: BackupStore, cfg: BackupS3Config, remaining: RemoteBackup[], now: Date, opts: Log = {}): Promise<number> {
  const log = opts.log ?? console.log;
  const cited = new Set<string>();
  for (const b of remaining) {
    if (!b.keys.includes(`${cfg.prefix}${b.folder}/${OBJECTS_FILE}`)) continue;
    const index = await readRemoteIndex(store, cfg, b.folder);
    for (const o of index?.objects ?? []) cited.add(blobKey(cfg, o.sha256));
  }
  const limit = now.getTime() - BLOB_GRACE_MS;
  const orphans = (await store.list(`${cfg.prefix}${BLOBS_DIR}/`))
    .filter((o) => !cited.has(o.key) && o.lastModified.getTime() < limit)
    .map((o) => o.key);
  if (orphans.length) {
    log(`[backup:objets] rétention : ${orphans.length} contenu(s) qu'aucune sauvegarde retenue ne cite, effacé(s)`);
    await store.remove(orphans);
  }
  return orphans.length;
}
