import { assertStorageBucketIsolated } from "@/lib/boot-guards";
import { dataRoot } from "@/lib/courses";
import { sdkBucket, type BucketConfig } from "@/lib/storage/bucket";
import { LocalFsStore } from "@/lib/storage/local";
import { S3Store } from "@/lib/storage/s3";

export { isObjectStored, relativeToRoot } from "@/lib/storage/keys";

/**
 * FICHIERS DE COURS (audit du 14/11/2026, axe 10).
 *
 * Toute lecture, écriture, suppression ou diffusion d'un fichier du dossier de
 * données (annales, sources, examens, captures) passe par `storage()`. Deux
 * adaptateurs :
 *  - `LocalFsStore` (défaut, aucune variable) : le disque, exactement comme avant ;
 *  - `S3Store` (STORAGE_S3_BUCKET posé) : un seau S3-compatible (Railway Buckets,
 *    Cloudflare R2, AWS) fait foi ; le dossier de données local n'est plus qu'un
 *    cache du seau, à la même arborescence.
 *
 * Les fichiers se désignent par leur CHEMIN LOCAL ABSOLU (celui de lib/courses
 * coursePaths), jamais par une clé : la clé est le chemin relatif au dossier de
 * données (`u/<compte>/<cours>/refs/…`), donc identique à l'arborescence du volume
 * et sans migration de base. Un chemin HORS du dossier de données (contenu d'un
 * cours historique dans le dépôt) n'est jamais dans le seau : les deux adaptateurs
 * le lisent sur le disque.
 *
 * Le moteur (pdftoppm, tectonic, vision, ingestion) travaille sur des fichiers :
 * il s'exécute dans `withLocalDir(chemins, fn)`, qui rapatrie ces dossiers depuis
 * le seau, lance `fn`, puis renvoie ce que `fn` a créé, modifié ou supprimé. Le
 * moteur garde ainsi ses chemins et ses appels synchrones. Le cache des images de
 * pages (lib/page-cache) n'y entre jamais : il reste local et purgeable.
 */

export type FileStat = { size: number; mtimeMs: number };
export type FileEntry = FileStat & { path: string };

export type ServeOptions = {
  contentType: string;
  /** En-têtes de la réponse (sécurité, cache, disposition…), cf. lib/security-headers. */
  headers: Record<string, string>;
};

export type PutOptions = {
  /** false s'il existait déjà (sur le disque ou dans le seau), rien n'est écrit. */
  exclusive?: boolean;
  /**
   * TRANSIT : le fichier reste sur le disque de ce conteneur et n'atteint jamais le seau, même à
   * travers withLocalDir tant qu'il n'est pas modifié. C'est l'original d'un compte gratuit, le
   * temps de son indexation : lib/originals le supprime ensuite (décision de Ben du 17/11/2026).
   */
  localOnly?: boolean;
};

export interface CourseFiles {
  readonly kind: "local" | "s3";
  /** Écrit un fichier (dossiers créés au besoin). Cf. PutOptions. */
  put(file: string, body: Buffer | Uint8Array | string, opts?: PutOptions): Promise<boolean>;
  /** Contenu d'un fichier ; null s'il n'existe pas. */
  read(file: string): Promise<Buffer | null>;
  /** Taille et date d'un FICHIER ; null s'il n'existe pas (un dossier n'est pas un fichier). */
  stat(file: string): Promise<FileStat | null>;
  /** Tous les fichiers sous `dir`, récursivement (liens symboliques ignorés). */
  list(dir: string): Promise<FileEntry[]>;
  /** Supprime un fichier, ou un dossier et tout son contenu ; absent = rien à faire. */
  remove(target: string): Promise<void>;
  /**
   * Réponse HTTP qui diffuse le fichier, plages d'octets (Range) comprises ; null
   * s'il n'existe pas. En S3, une navigation vers un PDF est redirigée vers une
   * URL présignée de courte durée (le serveur ne lit plus le PDF).
   */
  serve(file: string, req: Request, opts: ServeOptions): Promise<Response | null>;
  /** Octets occupés sous `dir`. */
  usageBytes(dir: string): Promise<number>;
  /**
   * Exécute `fn` avec les fichiers de `paths` (dossiers ou fichiers) présents sur
   * le disque local, puis rend durable ce que `fn` y a changé — y compris si `fn`
   * échoue (une reprise de job repart de ses fichiers). Local : `fn` tout court.
   */
  withLocalDir<T>(paths: string[], fn: () => Promise<T>): Promise<T>;
}

export type Env = Record<string, string | undefined>;

export type StorageS3Config = BucketConfig & {
  /** Préfixe des clés : sans `/` initial, avec `/` final, ou vide (défaut). */
  prefix: string;
  /** Navigation vers un PDF → URL présignée (défaut oui ; STORAGE_S3_PRESIGN=0 pour tout relayer). */
  presign: boolean;
};

const REQUIRED = ["STORAGE_S3_BUCKET", "STORAGE_S3_ENDPOINT", "STORAGE_S3_ACCESS_KEY_ID", "STORAGE_S3_SECRET_ACCESS_KEY"] as const;

/**
 * Aucune variable → null (disque local). Partielle → erreur nommant ce qui manque.
 * Seau recopié de la prod dans un autre environnement Railway → refus (audit fuites I15) :
 * vérifié ici, au seul point d'entrée vers le seau, pour l'app comme pour les scripts
 * lancés par `railway run` (backup-objects, storage-migrate), qui ne passent pas par le boot.
 */
export function storageS3Config(env: Env = process.env): StorageS3Config | null {
  const present = REQUIRED.filter((k) => (env[k] ?? "").trim() !== "");
  if (present.length === 0) return null;
  assertStorageBucketIsolated(env);
  const missing = REQUIRED.filter((k) => !present.includes(k));
  if (missing.length) throw new Error(`Stockage objet : configuration incomplète, variables manquantes : ${missing.join(", ")}`);
  const rawPrefix = (env.STORAGE_S3_PREFIX ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return {
    bucket: env.STORAGE_S3_BUCKET!.trim(),
    endpoint: env.STORAGE_S3_ENDPOINT!.trim(),
    accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY!.trim(),
    region: (env.STORAGE_S3_REGION ?? "").trim() || "auto",
    forcePathStyle: env.STORAGE_S3_PATH_STYLE === "1",
    prefix: rawPrefix ? `${rawPrefix}/` : "",
    presign: env.STORAGE_S3_PRESIGN !== "0",
  };
}

let current: CourseFiles | null = null;

/** Le stockage de l'instance, choisi une fois par process d'après l'environnement. */
export function storage(): CourseFiles {
  if (current) return current;
  const cfg = storageS3Config();
  const chosen: CourseFiles = cfg
    ? new S3Store({ bucket: sdkBucket(cfg), root: dataRoot(), prefix: cfg.prefix, presign: cfg.presign })
    : new LocalFsStore(dataRoot());
  current = chosen;
  return chosen;
}

/** (tests) impose un stockage ; null = retour au choix par l'environnement. */
export function setStorageForTests(s: CourseFiles | null): void {
  current = s;
}
