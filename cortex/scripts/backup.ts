/**
 * SAUVEGARDE — dump Postgres (si DATABASE_URL=postgres://…) + archive du volume
 * CORTEX_DATA_DIR, dans un dossier horodaté (BACKUP_DIR, défaut ./backups), et
 * en option envoi HORS SITE vers un stockage S3-compatible (BACKUP_S3_*).
 *
 * Usage :
 *   npm run backup                          # backup complet dans ./backups
 *   BACKUP_DIR=/mnt/bak npm run backup
 *   npm run backup -- --label=avant-migration
 *   npm run backup -- --push                # + envoi S3 (BACKUP_S3_* requis)
 *   npm run backup -- --push --prune        # + rétention BACKUP_KEEP_DAYS (défaut 14)
 *   npm run backup -- --push --no-local     # supprime la copie locale après envoi
 *                                           # (c'est ce que fait le planificateur quotidien)
 *
 * Idempotent (chaque exécution = un dossier distinct). Aucun secret loggé.
 * Détails : lib/backup.ts, lib/backup-s3.ts et DEPLOY.md §« Sauvegardes ».
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBackup } from "../lib/backup";
import { backupS3Config, pruneBackups, pushBackup, s3Store } from "../lib/backup-s3";
import { dataRoot } from "../lib/courses";
import { dbDriverName } from "../db/q";

function argValue(flag: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}
const hasFlag = (f: string) => process.argv.slice(2).includes(f);

async function main(): Promise<void> {
  const push = hasFlag("--push");
  const cfg = push ? backupS3Config() : null;
  if (push && !cfg) {
    throw new Error("--push demandé mais BACKUP_S3_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY ne sont pas posés.");
  }
  // Avec --push, la copie locale n'est qu'un relais : par défaut dans le dossier
  // temporaire, pas sur le volume (qu'il ne faut pas remplir de ses propres copies).
  const backupDir = process.env.BACKUP_DIR
    ? path.resolve(process.env.BACKUP_DIR)
    : push ? path.join(os.tmpdir(), "cortex-backups") : path.join(process.cwd(), "backups");

  const { dir, manifest } = await createBackup({
    dataDir: dataRoot(),
    backupDir,
    databaseUrl: process.env.DATABASE_URL,
    dbDriver: dbDriverName(),
    label: argValue("--label"),
  });

  console.log(`\n✓ Sauvegarde créée : ${dir}`);
  console.log(`  volume   : ${manifest.dataDir.archive} (${(manifest.dataDir.bytes / 1024).toFixed(0)} Kio)`);
  if (manifest.postgres) {
    console.log(`  postgres : ${manifest.postgres.file} (${(manifest.postgres.bytes / 1024).toFixed(0)} Kio)`);
  } else if (manifest.pglite) {
    console.log(`  pglite   : ${manifest.pglite.file} (${(manifest.pglite.bytes / 1024).toFixed(0)} Kio)`);
  } else {
    console.log(`  base     : SQLite (incluse dans l'archive du volume)`);
  }

  if (cfg) {
    const store = s3Store(cfg);
    const { folder, keys } = await pushBackup(store, cfg, dir);
    console.log(`✓ Envoyée hors site : ${keys.length} objet(s) sous ${cfg.prefix}${folder}/ (bucket ${cfg.bucket})`);
    if (hasFlag("--prune")) {
      const deleted = await pruneBackups(store, cfg);
      console.log(deleted.length ? `✓ Rétention ${cfg.keepDays} j : ${deleted.length} dossier(s) supprimé(s)` : `  Rétention ${cfg.keepDays} j : rien à supprimer`);
    }
    if (hasFlag("--no-local")) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`  Copie locale supprimée.`);
    }
    console.log(`  Pour vérifier : npm run backup:verify -- --latest`);
  } else {
    console.log(`  Pour vérifier : npm run backup:verify -- ${dir}`);
    console.log(`  Pour restaurer : npm run restore -- ${dir} --yes`);
  }
}

main().catch((e) => {
  console.error("[backup] ÉCHEC :", (e as Error).message);
  process.exit(1);
});
