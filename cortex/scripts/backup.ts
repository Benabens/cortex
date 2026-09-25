/**
 * SAUVEGARDE — dump Postgres (si DATABASE_URL=postgres://…) + archive du volume
 * CORTEX_DATA_DIR, dans un dossier horodaté (BACKUP_DIR, défaut ./backups).
 *
 * Usage :
 *   npm run backup                 # backup complet dans ./backups
 *   BACKUP_DIR=/mnt/bak npm run backup
 *   npm run backup -- --label=avant-migration
 *
 * Idempotent (chaque exécution = un dossier distinct). Aucun secret loggé.
 * Détails : lib/backup.ts et DEPLOY.md §« Sauvegardes et restauration ».
 */
import path from "node:path";
import { createBackup } from "../lib/backup";
import { dataRoot } from "../lib/courses";
import { dbDriverName } from "../db/q";

function argValue(flag: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

async function main(): Promise<void> {
  const backupDir = process.env.BACKUP_DIR
    ? path.resolve(process.env.BACKUP_DIR)
    : path.join(process.cwd(), "backups");

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
  console.log(`  Pour restaurer : npm run restore -- ${dir} --yes`);
}

main().catch((e) => {
  console.error("[backup] ÉCHEC :", (e as Error).message);
  process.exit(1);
});
