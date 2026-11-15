import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isNotFound, type ObjectBucket } from "@/lib/storage/bucket";
import { isObjectStored, relativeToRoot } from "@/lib/storage/keys";
import { walkFiles } from "@/lib/storage/local";
import { contentTypeOf } from "@/lib/storage/s3";

/**
 * MIGRATION DU VOLUME VERS LE SEAU (scripts/storage-migrate.ts).
 *
 * Copie chaque fichier de cours du dossier de données sous la même clé (chemin
 * relatif, préfixe éventuel) : aucune ligne de base ne change. Idempotente : un
 * objet déjà présent, de même taille et pas plus ancien que le fichier, n'est pas
 * renvoyé. Ne supprime jamais rien, ni dans le seau ni sur le volume. Bases
 * SQLite, cache des pages et temporaires restent locaux (isObjectStored).
 *
 * La vérification relit chaque objet et compare son SHA-256 à celui du fichier :
 * une taille égale ne prouve pas un contenu égal.
 */

export type MigrateOptions = {
  bucket: ObjectBucket;
  root: string;
  prefix: string;
  /** false (défaut du script) : plan seul, rien n'est envoyé. */
  write: boolean;
  /** Restreint à un sous-dossier (chemin relatif, ex. « u/ben »). */
  only?: string;
  log?: (msg: string) => void;
};

export type VerifyReport = { checked: number; mismatched: string[]; missing: string[] };

export type MigrateReport = {
  /** Fichiers de cours sur le volume. */
  files: number;
  /** Clés relatives à envoyer (absentes du seau, ou différentes). */
  toUpload: string[];
  bytesToUpload: number;
  uploaded: number;
  /** Vérification des empreintes (seulement après --write). */
  verify?: VerifyReport;
};

function courseFiles(root: string, only?: string): { rel: string; path: string; size: number; mtimeMs: number }[] {
  const base = only ? path.join(root, only) : root;
  return walkFiles(base)
    .map((f) => ({ ...f, rel: relativeToRoot(root, f.path) }))
    .filter((f): f is typeof f & { rel: string } => !!f.rel && isObjectStored(f.rel))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** Fichiers de cours du volume dont le seau n'a pas de copie à jour (absente, autre taille, plus ancienne). */
async function pendingFiles(opts: Omit<MigrateOptions, "write">) {
  const files = courseFiles(opts.root, opts.only);
  const remote = new Map((await opts.bucket.list(opts.prefix + (opts.only ?? ""))).map((o) => [o.key, o]));
  const pending = files.filter((f) => {
    const o = remote.get(opts.prefix + f.rel);
    // LastModified est à la seconde (S3) : le fichier n'est plus récent que s'il l'est d'une seconde entière.
    return !o || o.size !== f.size || Math.floor(f.mtimeMs / 1000) * 1000 > o.lastModified.getTime();
  });
  return { files, pending };
}

/**
 * Prédicat pour la sauvegarde : vrai si le fichier (chemin relatif) est un fichier
 * de cours dont le seau a déjà une copie à jour. Un fichier resté local (envoi
 * d'un worker en échec, script lancé à la main) est faux : il reste archivé.
 */
export async function inBucketPredicate(opts: Omit<MigrateOptions, "write" | "only">): Promise<(rel: string) => boolean> {
  const { pending } = await pendingFiles(opts);
  const local = new Set(pending.map((f) => f.rel));
  return (rel) => isObjectStored(rel) && !local.has(rel);
}

export async function migrateToBucket(opts: MigrateOptions): Promise<MigrateReport> {
  const log = opts.log ?? console.log;
  const { files, pending } = await pendingFiles(opts);
  const report: MigrateReport = {
    files: files.length,
    toUpload: pending.map((f) => f.rel),
    bytesToUpload: pending.reduce((n, f) => n + f.size, 0),
    uploaded: 0,
  };
  log(`[storage:migrate] ${files.length} fichier(s) de cours, ${pending.length} à envoyer (${(report.bytesToUpload / 1024 / 1024).toFixed(1)} Mo)`);
  if (!opts.write) {
    for (const f of pending.slice(0, 20)) log(`  à envoyer : ${f.rel}`);
    if (pending.length > 20) log(`  … et ${pending.length - 20} autre(s)`);
    log("[storage:migrate] à blanc : rien n'a été envoyé (relancer avec --write).");
    return report;
  }
  for (const f of pending) {
    await opts.bucket.put(opts.prefix + f.rel, { path: f.path, size: f.size }, contentTypeOf(f.path));
    report.uploaded++;
    if (report.uploaded % 100 === 0) log(`  ${report.uploaded}/${pending.length} envoyé(s)…`);
  }
  log(`[storage:migrate] ${report.uploaded} fichier(s) envoyé(s). Vérification des empreintes…`);
  report.verify = await verifyBucket(opts);
  return report;
}

/** Relit chaque objet du seau et compare son SHA-256 au fichier du volume. */
export async function verifyBucket(opts: Omit<MigrateOptions, "write">): Promise<VerifyReport> {
  const log = opts.log ?? console.log;
  const out: VerifyReport = { checked: 0, mismatched: [], missing: [] };
  for (const f of courseFiles(opts.root, opts.only)) {
    out.checked++;
    let remote: Buffer;
    try {
      remote = await opts.bucket.get(opts.prefix + f.rel);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      out.missing.push(f.rel);
      continue;
    }
    if (sha256(remote) !== sha256(fs.readFileSync(f.path))) out.mismatched.push(f.rel);
  }
  const ok = !out.mismatched.length && !out.missing.length;
  log(`[storage:migrate] empreintes : ${out.checked} vérifiée(s)${ok ? ", toutes identiques ✓" : `, ${out.mismatched.length} différente(s), ${out.missing.length} absente(s) du seau`}`);
  for (const k of out.mismatched.slice(0, 20)) log(`  différente : ${k}`);
  for (const k of out.missing.slice(0, 20)) log(`  absente : ${k}`);
  return out;
}
