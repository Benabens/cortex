import fs from "node:fs";
import { Readable } from "node:stream";
import type { ObjectBucket, S3Object } from "../../lib/storage/bucket";

/**
 * Faux seau S3 en mémoire : une Map clé → {corps, date, type}. `clock` pilote
 * LastModified (défaut : l'heure réelle, tronquée à la seconde comme un vrai seau) ; `calls` trace les opérations (les tests comptent les envois).
 * Un objet absent lève une erreur NoSuchKey, comme le SDK.
 */
export function fakeBucket(clock?: { now: Date }) {
  const objects = new Map<string, { body: Buffer; at: Date; contentType?: string }>();
  const calls: string[] = [];
  const bodies: ("buffer" | "file")[] = [];
  const notFound = (key: string) => Object.assign(new Error(`NoSuchKey: ${key}`), { name: "NoSuchKey" });
  const bucket: ObjectBucket = {
    async put(key, body, contentType) {
      bodies.push(Buffer.isBuffer(body) ? "buffer" : "file");
      const bytes = Buffer.isBuffer(body) ? Buffer.from(body) : fs.readFileSync(body.path);
      if (!Buffer.isBuffer(body) && bytes.length !== body.size) throw new Error("taille annoncée ≠ taille réelle");
      const at = clock ? new Date(clock.now) : new Date();
      at.setMilliseconds(0); // comme S3 : LastModified à la seconde
      objects.set(key, { body: bytes, at, contentType });
      calls.push(`put ${key}`);
    },
    async list(prefix) {
      calls.push(`list ${prefix}`);
      const out: S3Object[] = [];
      for (const [key, v] of objects) if (key.startsWith(prefix)) out.push({ key, lastModified: v.at, size: v.body.length });
      return out;
    },
    async remove(keys) {
      for (const k of keys) { objects.delete(k); calls.push(`remove ${k}`); }
    },
    async get(key) {
      calls.push(`get ${key}`);
      const v = objects.get(key);
      if (!v) throw notFound(key);
      return v.body;
    },
    async head(key) {
      calls.push(`head ${key}`);
      const v = objects.get(key);
      return v ? { size: v.body.length, lastModified: v.at } : null;
    },
    async stream(key, range) {
      calls.push(`stream ${key}${range ? ` ${range.start}-${range.end}` : ""}`);
      const v = objects.get(key);
      if (!v) return null;
      const slice = range ? v.body.subarray(range.start, range.end + 1) : v.body;
      return { body: Readable.from([slice]), size: v.body.length, ...(range ? { range } : {}) };
    },
    async presign(key, opts) {
      calls.push(`presign ${key}`);
      const q = new URLSearchParams({ "X-Amz-Expires": String(opts.expiresInSec) });
      if (opts.contentType) q.set("response-content-type", opts.contentType);
      if (opts.contentDisposition) q.set("response-content-disposition", opts.contentDisposition);
      return `https://bucket.example.test/${encodeURI(key)}?${q}`;
    },
  };
  return { bucket, objects, calls, bodies, clock };
}
