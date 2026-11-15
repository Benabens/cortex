/**
 * PORT « SEAU D'OBJETS » : ce que Cortex demande à un stockage S3-compatible.
 *
 * Deux usages le partagent : les sauvegardes hors site (lib/backup-s3, qui n'en
 * consomme que put/list/remove/get) et les fichiers de cours (lib/storage/s3).
 * Un seul adaptateur réel, `sdkBucket`, branche le SDK AWS v3 ; les tests passent
 * un faux seau en mémoire (tests/helpers/fake-bucket.ts).
 *
 * Contrat d'erreur : un objet absent se dit par `null` (head, stream) ou par une
 * erreur reconnue par `isNotFound` (get), jamais par un tampon vide.
 */
import fs from "node:fs";
import type { Readable } from "node:stream";

export type S3Object = { key: string; lastModified: Date; size: number };

/** Corps d'un envoi : un fichier (chemin + taille, envoyé en flux) ou un petit tampon. */
export type PutBody = Buffer | { path: string; size: number };

/** Plage d'octets inclusive, comme l'en-tête HTTP Range. */
export type ByteRange = { start: number; end: number };

export type ObjectStream = {
  body: Readable;
  /** Taille totale de l'objet (pas celle de la plage). */
  size: number;
  /** Plage effectivement renvoyée (absente = objet entier). */
  range?: ByteRange;
};

export type PresignOptions = {
  expiresInSec: number;
  contentType?: string;
  contentDisposition?: string;
  cacheControl?: string;
};

export interface ObjectBucket {
  put(key: string, body: PutBody, contentType?: string): Promise<void>;
  list(prefix: string): Promise<S3Object[]>;
  remove(keys: string[]): Promise<void>;
  /** Objet entier ; absent → erreur reconnue par `isNotFound`. */
  get(key: string): Promise<Buffer>;
  head(key: string): Promise<{ size: number; lastModified: Date } | null>;
  stream(key: string, range?: ByteRange): Promise<ObjectStream | null>;
  presign(key: string, opts: PresignOptions): Promise<string>;
}

export type BucketConfig = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Chemin « path-style » (MinIO, anciens seaux) ; sinon « virtual-hosted » (Railway, R2, AWS). */
  forcePathStyle: boolean;
};

/** L'erreur dit-elle « cet objet n'existe pas » ? (SDK : NoSuchKey / NotFound / 404.) */
export function isNotFound(e: unknown): boolean {
  const err = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | null;
  return !!err && (err.name === "NoSuchKey" || err.name === "NotFound" || err.Code === "NoSuchKey" || err.$metadata?.httpStatusCode === 404);
}

/** Vrai seau S3 (SDK AWS v3). Import paresseux : le SDK n'est chargé que si un seau est configuré. */
export function sdkBucket(cfg: BucketConfig): ObjectBucket {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const s3 = require("@aws-sdk/client-s3") as typeof import("@aws-sdk/client-s3");
  const client = new s3.S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  const Bucket = cfg.bucket;
  return {
    async put(key, body, contentType) {
      // Flux : une archive de plusieurs Go ne passe jamais en mémoire.
      const Body = Buffer.isBuffer(body) ? body : fs.createReadStream(body.path);
      const ContentLength = Buffer.isBuffer(body) ? body.length : body.size;
      await client.send(new s3.PutObjectCommand({ Bucket, Key: key, Body, ContentType: contentType, ContentLength }));
    },
    async list(prefix) {
      const out: S3Object[] = [];
      let token: string | undefined;
      do {
        const r = await client.send(new s3.ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of r.Contents ?? []) {
          if (o.Key) out.push({ key: o.Key, lastModified: o.LastModified ?? new Date(0), size: o.Size ?? 0 });
        }
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async remove(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000);
        await client.send(new s3.DeleteObjectsCommand({ Bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }));
      }
    },
    async get(key) {
      const r = await client.send(new s3.GetObjectCommand({ Bucket, Key: key }));
      const bytes = await r.Body?.transformToByteArray();
      if (!bytes) throw Object.assign(new Error(`Objet vide ou introuvable : ${key}`), { name: "NoSuchKey" });
      return Buffer.from(bytes);
    },
    async head(key) {
      try {
        const r = await client.send(new s3.HeadObjectCommand({ Bucket, Key: key }));
        return { size: r.ContentLength ?? 0, lastModified: r.LastModified ?? new Date(0) };
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async stream(key, range) {
      try {
        const r = await client.send(new s3.GetObjectCommand({ Bucket, Key: key, Range: range ? `bytes=${range.start}-${range.end}` : undefined }));
        // Content-Range : « bytes a-b/total » ; sans plage, la taille est ContentLength.
        const total = /\/(\d+)$/.exec(r.ContentRange ?? "")?.[1];
        return {
          body: r.Body as Readable,
          size: total ? Number(total) : r.ContentLength ?? 0,
          ...(range && r.ContentRange ? { range } : {}),
        };
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async presign(key, opts) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getSignedUrl } = require("@aws-sdk/s3-request-presigner") as typeof import("@aws-sdk/s3-request-presigner");
      const cmd = new s3.GetObjectCommand({
        Bucket,
        Key: key,
        ResponseContentType: opts.contentType,
        ResponseContentDisposition: opts.contentDisposition,
        ResponseCacheControl: opts.cacheControl,
      });
      return getSignedUrl(client, cmd, { expiresIn: opts.expiresInSec });
    },
  };
}
