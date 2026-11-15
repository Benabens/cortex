import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { CourseFiles, FileEntry, FileStat, ServeOptions } from "@/lib/storage";
import { isNotFound, type ObjectBucket, type S3Object } from "@/lib/storage/bucket";
import { parseRange, rangedResponse, serveLocalFile } from "@/lib/storage/http";
import { isObjectStored, relativeToRoot } from "@/lib/storage/keys";
import { statLocal, walkFiles, writeLocal } from "@/lib/storage/local";

/**
 * ADAPTATEUR SEAU : le seau fait foi, le dossier de données local en est le cache.
 *
 * Écriture : envoi au seau, PUIS copie locale (un envoi raté ne laisse pas de
 * fichier qui aurait l'air présent). La copie locale est datée APRÈS l'envoi :
 * elle n'est pas plus vieille que l'objet, donc jamais retéléchargée pour rien.
 *
 * Lecture : le seau d'abord ; un fichier absent du seau mais présent sur le disque
 * est un fichier qu'un worker du MÊME conteneur vient d'écrire et dont l'envoi
 * n'est pas fini (le job passe « terminé » juste avant) : il est lu sur le disque.
 * Ce repli suppose un seul conteneur qui écrit (c'est le cas : un réplica) ; une
 * suppression passe toujours par `remove`, qui efface aussi la copie locale.
 *
 * withLocalDir : rapatrie ce qui manque ou a changé dans le seau (taille, ou objet
 * plus récent que la copie), photographie le disque, lance le moteur, puis renvoie
 * tout fichier nouveau ou modifié et supprime du seau ce que le moteur a effacé.
 * Le rapatriement n'efface jamais un fichier local : un autre job du même
 * conteneur peut être en train d'écrire le sien.
 */

export type S3StoreOptions = {
  bucket: ObjectBucket;
  /** Dossier de données local (cache), même arborescence que les clés. */
  root: string;
  /** Préfixe des clés ("" ou « x/ »). */
  prefix: string;
  /** Navigation vers un PDF → URL présignée. */
  presign: boolean;
};

const PRESIGN_TTL_SEC = 300;
const PARALLEL = 8;

const MIME: Record<string, string> = {
  pdf: "application/pdf", html: "text/html", htm: "text/html", txt: "text/plain", md: "text/plain",
  tex: "text/plain", c: "text/plain", h: "text/plain", json: "application/json", csv: "text/csv",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const contentTypeOf = (file: string) => MIME[path.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream";

/** Exécute `fn` sur chaque élément, au plus `n` à la fois. */
async function eachLimit<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

export class S3Store implements CourseFiles {
  readonly kind = "s3" as const;
  private readonly bucket: ObjectBucket;
  private readonly root: string;
  private readonly prefix: string;
  private readonly presign: boolean;

  constructor(opts: S3StoreOptions) {
    this.bucket = opts.bucket;
    this.root = path.resolve(opts.root);
    this.prefix = opts.prefix;
    this.presign = opts.presign;
  }

  /** Clé d'un fichier de cours ; null = fichier purement local (hors données, cache, base). */
  private keyOf(file: string): string | null {
    const rel = relativeToRoot(this.root, file);
    return rel && isObjectStored(rel) ? this.prefix + rel : null;
  }

  private localOf(key: string): string {
    return path.join(this.root, ...key.slice(this.prefix.length).split("/"));
  }

  /** Objets du seau sous `key` (la clé elle-même, ou ce qui est rangé dessous). */
  private async objectsUnder(key: string): Promise<S3Object[]> {
    return (await this.bucket.list(key)).filter((o) => o.key === key || o.key.startsWith(`${key}/`));
  }

  /** Date la copie locale de l'instant présent : jamais plus vieille que l'objet envoyé. */
  private touch(file: string): void {
    const now = new Date();
    try { fs.utimesSync(file, now, now); } catch { /* disparu entre-temps */ }
  }

  async put(file: string, body: Buffer | Uint8Array | string, opts: { exclusive?: boolean } = {}) {
    const key = this.keyOf(file);
    if (!key) return writeLocal(file, body, opts.exclusive);
    if (opts.exclusive) {
      if (await this.bucket.head(key)) return false;
      // Le disque tranche entre deux écritures concurrentes du même conteneur (O_EXCL).
      if (!writeLocal(file, body, true)) return false;
      try {
        await this.bucket.put(key, Buffer.from(body), contentTypeOf(file));
      } catch (e) {
        try { fs.unlinkSync(file); } catch { /* déjà parti */ }
        throw e;
      }
      this.touch(file);
      return true;
    }
    await this.bucket.put(key, Buffer.from(body), contentTypeOf(file));
    writeLocal(file, body);
    return true;
  }

  async read(file: string) {
    const key = this.keyOf(file);
    if (key) {
      try { return await this.bucket.get(key); } catch (e) { if (!isNotFound(e)) throw e; }
    }
    try { return fs.readFileSync(file); } catch { return null; }
  }

  async stat(file: string): Promise<FileStat | null> {
    const key = this.keyOf(file);
    const remote = key ? await this.bucket.head(key) : null;
    return remote ? { size: remote.size, mtimeMs: remote.lastModified.getTime() } : statLocal(file);
  }

  async list(dir: string): Promise<FileEntry[]> {
    const key = this.keyOf(dir);
    const local = walkFiles(dir);
    if (!key) return local;
    const out = new Map<string, FileEntry>();
    for (const o of await this.objectsUnder(key)) {
      if (o.key === key) continue; // `dir` est un fichier, pas un dossier
      const p = this.localOf(o.key);
      out.set(p, { path: p, size: o.size, mtimeMs: o.lastModified.getTime() });
    }
    for (const f of local) {
      const rel = relativeToRoot(this.root, f.path);
      if (rel && isObjectStored(rel) && !out.has(f.path)) out.set(f.path, f);
    }
    return [...out.values()];
  }

  async remove(target: string) {
    const rel = relativeToRoot(this.root, target);
    if (rel) {
      const key = this.prefix + rel;
      const keys = (await this.objectsUnder(key)).map((o) => o.key);
      if (keys.length) await this.bucket.remove(keys);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }

  async serve(file: string, req: Request, opts: ServeOptions): Promise<Response | null> {
    const headers = { ...opts.headers, "content-type": opts.contentType };
    const key = this.keyOf(file);
    const remote = key ? await this.bucket.head(key) : null;
    if (!key || !remote) {
      const s = statLocal(file);
      return s ? serveLocalFile(file, s.size, req, headers) : null;
    }
    // Navigation vers un PDF : le navigateur va le chercher dans le seau (plages
    // comprises), le serveur ne le lit plus. Jamais pour un contenu embarqué
    // (<iframe>, <img>…) : la CSP (default-src 'self') bloquerait le domaine du
    // seau ; jamais pour du HTML, qui doit garder sa CSP « sandbox ».
    const isPdf = /^application\/pdf\b/i.test(opts.contentType);
    if (this.presign && isPdf && req.method === "GET" && req.headers.get("sec-fetch-dest") === "document") {
      const url = await this.bucket.presign(key, {
        expiresInSec: PRESIGN_TTL_SEC,
        contentType: opts.contentType,
        contentDisposition: opts.headers["content-disposition"],
        cacheControl: opts.headers["cache-control"],
      });
      return new Response(null, { status: 302, headers: { location: url, "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
    }
    const range = parseRange(req.headers.get("range"), remote.size);
    if (range === "unsatisfiable" || req.method === "HEAD") return rangedResponse(null, remote.size, range, headers);
    const obj = await this.bucket.stream(key, range ?? undefined);
    if (!obj) return null;
    return rangedResponse(obj.body, obj.size, range, headers);
  }

  async usageBytes(dir: string) {
    return (await this.list(dir)).reduce((n, f) => n + f.size, 0);
  }

  async withLocalDir<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
    const targets = paths
      .map((p) => ({ abs: path.resolve(p), key: this.keyOf(p) }))
      .filter((t): t is { abs: string; key: string } => !!t.key);
    for (const t of targets) await this.hydrate(t.key);
    const before = this.snapshot(targets.map((t) => t.abs));
    let result: T;
    try {
      result = await fn();
    } catch (e) {
      try { await this.flush(targets.map((t) => t.abs), before); } catch (flushErr) {
        console.error(`[storage] envoi au seau après échec impossible : ${(flushErr as Error).message}`);
      }
      throw e;
    }
    await this.flush(targets.map((t) => t.abs), before);
    return result;
  }

  /** Rapatrie les objets absents du disque, de taille différente ou plus récents que la copie. */
  private async hydrate(key: string): Promise<void> {
    const stale = (await this.objectsUnder(key)).filter((o) => {
      const s = statLocal(this.localOf(o.key));
      return !s || s.size !== o.size || s.mtimeMs < o.lastModified.getTime();
    });
    await eachLimit(stale, PARALLEL, async (o) => {
      const dest = this.localOf(o.key);
      const obj = await this.bucket.stream(o.key);
      if (!obj) return; // supprimé entre le listage et le téléchargement
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // Temporaire + renommage : un lecteur concurrent ne voit jamais un fichier à moitié écrit.
      const tmp = `${dest}.cortex-dl-${randomBytes(4).toString("hex")}`;
      try {
        await pipeline(obj.body, fs.createWriteStream(tmp));
        fs.utimesSync(tmp, o.lastModified, o.lastModified);
        fs.renameSync(tmp, dest);
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* renommé */ }
      }
    });
  }

  private snapshot(abs: string[]): Map<string, FileStat> {
    const out = new Map<string, FileStat>();
    for (const a of abs) {
      const one = statLocal(a);
      const files = one ? [{ path: a, ...one }] : walkFiles(a);
      for (const f of files) {
        const rel = relativeToRoot(this.root, f.path);
        if (rel && isObjectStored(rel)) out.set(f.path, { size: f.size, mtimeMs: f.mtimeMs });
      }
    }
    return out;
  }

  /** Renvoie au seau ce qui a changé depuis `before`, supprime ce qui a disparu. */
  private async flush(abs: string[], before: Map<string, FileStat>): Promise<void> {
    const now = this.snapshot(abs);
    const changed = [...now].filter(([p, s]) => {
      const prev = before.get(p);
      return !prev || prev.size !== s.size || prev.mtimeMs !== s.mtimeMs;
    });
    await eachLimit(changed, PARALLEL, async ([p, s]) => {
      await this.bucket.put(this.keyOf(p)!, { path: p, size: s.size }, contentTypeOf(p));
      this.touch(p);
    });
    const gone = [...before.keys()].filter((p) => !now.has(p)).map((p) => this.keyOf(p)!);
    if (gone.length) await this.bucket.remove(gone);
  }
}
