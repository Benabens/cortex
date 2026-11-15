/**
 * SAUVEGARDES HORS SITE — envoi des dossiers produits par lib/backup vers un
 * stockage S3-compatible (Cloudflare R2, Backblaze B2, MinIO, AWS…).
 *
 * Pourquoi : le volume Railway n'est PAS snapshoté et la base Postgres l'est
 * seulement côté hébergeur. Un dump quotidien poussé ailleurs est le seul
 * filet réellement hors du panier.
 *
 * Disposition distante : <BACKUP_S3_PREFIX>/<dossier-de-backup>/<fichier>.
 * `manifest.json` est envoyé EN DERNIER : sa présence atteste qu'un dossier est
 * complet (un envoi coupé laisse un dossier « incomplet », purgé à la
 * rétention). La rétention ne supprime JAMAIS le dossier complet le plus
 * récent, même expiré : mieux vaut une vieille sauvegarde qu'aucune.
 * `<BACKUP_S3_PREFIX>_objets/` (réservé) range les contenus des objets du seau
 * de fichiers par empreinte (lib/backup-objects) ; la rétention efface ceux
 * qu'aucune sauvegarde retenue ne cite plus.
 *
 * Le client S3 est derrière l'interface `BackupStore` (sous-ensemble du port
 * lib/storage/bucket) : les tests utilisent un faux magasin en mémoire ;
 * `s3Store()` branche le vrai SDK.
 *
 * SECRETS : la clé secrète n'est jamais loggée ; aucune URL de base non plus.
 */
import fs from "node:fs";
import path from "node:path";
import { BLOBS_DIR, pruneBlobs } from "@/lib/backup-objects";
import { sdkBucket, type PutBody, type S3Object } from "@/lib/storage/bucket";

export type { PutBody, S3Object };

export interface BackupStore {
  put(key: string, body: PutBody, contentType?: string): Promise<void>;
  list(prefix: string): Promise<S3Object[]>;
  remove(keys: string[]): Promise<void>;
  get(key: string): Promise<Buffer>;
}

export type BackupS3Config = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Préfixe distant normalisé : sans `/` initial, avec `/` final (défaut `cortex/`). */
  prefix: string;
  /** Rétention en jours (BACKUP_KEEP_DAYS, défaut 14). */
  keepDays: number;
};

export type Env = Record<string, string | undefined>;

const REQUIRED = ["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY"] as const;

/**
 * Lit la configuration. Aucune des 4 variables → null (sauvegardes hors site
 * désactivées, comportement historique). Partielle → erreur nommant ce qui manque.
 */
export function backupS3Config(env: Env = process.env): BackupS3Config | null {
  const present = REQUIRED.filter((k) => (env[k] ?? "").trim() !== "");
  if (present.length === 0) return null;
  const missing = REQUIRED.filter((k) => !present.includes(k));
  if (missing.length) {
    throw new Error(`Sauvegardes S3 : configuration incomplète, variables manquantes : ${missing.join(", ")}`);
  }
  const keepRaw = (env.BACKUP_KEEP_DAYS ?? "").trim();
  const keepDays = keepRaw === "" ? 14 : Number(keepRaw);
  if (!Number.isInteger(keepDays) || keepDays < 1) {
    throw new Error(`BACKUP_KEEP_DAYS doit être un entier ≥ 1 (reçu « ${keepRaw} »)`);
  }
  const rawPrefix = (env.BACKUP_S3_PREFIX ?? "cortex").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return {
    endpoint: env.BACKUP_S3_ENDPOINT!.trim(),
    bucket: env.BACKUP_S3_BUCKET!.trim(),
    accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY!.trim(),
    region: (env.BACKUP_S3_REGION ?? "").trim() || "auto",
    prefix: rawPrefix ? `${rawPrefix}/` : "",
    keepDays,
  };
}

/** Vrai magasin S3 (SDK AWS v3, chemin « path-style » : compatible R2/B2/MinIO). */
export function s3Store(cfg: BackupS3Config): BackupStore {
  return sdkBucket({ ...cfg, forcePathStyle: true });
}

type Log = { log?: (msg: string) => void };
const MANIFEST = "manifest.json";

function contentTypeFor(file: string): string {
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".tar.gz")) return "application/gzip";
  return "application/octet-stream";
}

/** Envoie un dossier de backup local. `manifest.json` part en dernier (témoin de complétude). */
export async function pushBackup(store: BackupStore, cfg: BackupS3Config, dir: string, opts: Log = {}): Promise<{ folder: string; keys: string[] }> {
  const log = opts.log ?? console.log;
  const folder = path.basename(path.resolve(dir));
  if (!fs.existsSync(path.join(dir, MANIFEST))) throw new Error(`Dossier de backup sans ${MANIFEST} : ${dir}`);
  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile() && f !== MANIFEST).sort();
  files.push(MANIFEST);
  const keys: string[] = [];
  for (const f of files) {
    const key = `${cfg.prefix}${folder}/${f}`;
    const file = path.join(dir, f);
    const size = fs.statSync(file).size;
    log(`[backup:s3] → ${key} (${(size / 1024).toFixed(0)} Kio)`);
    await store.put(key, { path: file, size }, contentTypeFor(f));
    keys.push(key);
  }
  return { folder, keys };
}

export type RemoteBackup = { folder: string; createdAt: Date; complete: boolean; bytes: number; keys: string[] };

/** Dossiers distants, du plus récent au plus ancien (date = objet le plus récent du dossier). */
export async function listRemoteBackups(store: BackupStore, cfg: BackupS3Config): Promise<RemoteBackup[]> {
  const byFolder = new Map<string, RemoteBackup>();
  for (const o of await store.list(cfg.prefix)) {
    const rel = o.key.slice(cfg.prefix.length);
    const slash = rel.indexOf("/");
    if (slash <= 0) continue;
    const folder = rel.slice(0, slash);
    if (folder === BLOBS_DIR) continue; // contenus des objets du seau (lib/backup-objects), pas une sauvegarde
    const file = rel.slice(slash + 1);
    const cur = byFolder.get(folder) ?? { folder, createdAt: new Date(0), complete: false, bytes: 0, keys: [] };
    cur.keys.push(o.key);
    cur.bytes += o.size;
    if (o.lastModified > cur.createdAt) cur.createdAt = o.lastModified;
    if (file === MANIFEST) cur.complete = true;
    byFolder.set(folder, cur);
  }
  return [...byFolder.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.folder.localeCompare(b.folder));
}

/**
 * Supprime les dossiers complets remplacés depuis plus de `keepDays` (par une
 * sauvegarde complète plus récente) et les dossiers incomplets plus vieux que
 * `keepDays`. Le dossier complet le plus récent est TOUJOURS conservé.
 */
export async function pruneBackups(store: BackupStore, cfg: BackupS3Config, now: Date = new Date(), opts: Log = {}): Promise<string[]> {
  const log = opts.log ?? console.log;
  const all = await listRemoteBackups(store, cfg);
  const newestComplete = all.find((b) => b.complete);
  const limit = now.getTime() - cfg.keepDays * 86_400_000;
  const deleted: string[] = [];
  let newerComplete: RemoteBackup | null = null; // `all` va du plus récent au plus ancien
  for (const b of all) {
    // Un état complet est gardé `keepDays` après avoir été REMPLACÉ par le suivant :
    // un objet supprimé du seau juste avant une sauvegarde n'est cité que par la
    // précédente, qui reste donc restaurable keepDays pleins après la suppression.
    const since = b.complete ? newerComplete?.createdAt ?? null : b.createdAt;
    if (b.complete) newerComplete = b;
    if (b === newestComplete || !since) continue;
    if (since.getTime() >= limit) continue;
    log(`[backup:s3] rétention ${cfg.keepDays} j : suppression de ${b.folder}${b.complete ? "" : " (incomplet)"}`);
    await store.remove(b.keys);
    deleted.push(b.folder);
  }
  // Contenus des objets du seau qu'aucune sauvegarde retenue ne cite plus.
  await pruneBlobs(store, cfg, all.filter((b) => !deleted.includes(b.folder)), now, opts);
  return deleted;
}

/** Rapatrie un dossier distant dans `destDir` (créé au besoin). */
export async function pullBackup(store: BackupStore, cfg: BackupS3Config, folder: string, destDir: string, opts: Log = {}): Promise<string> {
  const log = opts.log ?? console.log;
  const prefix = `${cfg.prefix}${folder}/`;
  const objects = await store.list(prefix);
  if (!objects.length) throw new Error(`Aucune sauvegarde distante nommée ${folder}`);
  fs.mkdirSync(destDir, { recursive: true });
  for (const o of objects) {
    const file = o.key.slice(prefix.length);
    if (!file || file.includes("/") || file.includes("..")) continue;
    log(`[backup:s3] ← ${o.key}`);
    fs.writeFileSync(path.join(destDir, file), await store.get(o.key));
  }
  return destDir;
}
