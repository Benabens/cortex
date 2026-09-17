/**
 * RESTAURATION depuis un dossier de sauvegarde produit par `npm run backup`.
 *
 * Usage :
 *   npm run restore -- ./backups/cortex-backup-20260908-120000 --yes
 *   npm run restore -- <dossier> --yes --force     # écrase une cible non vide
 *
 * GARDE-FOUS (cf. lib/backup.ts) :
 *   - refuse sans --yes ;
 *   - refuse si le volume CORTEX_DATA_DIR ou la base Postgres cible ne sont pas
 *     vides, sauf --force ;
 *   - vérifie les empreintes SHA-256 de l'archive avant d'écrire.
 *
 * ⚠️ Opération DESTRUCTRICE avec --force : elle écrase les données existantes.
 */
import { restoreBackup } from "../lib/backup";
import { dataRoot } from "../lib/courses";
import { dbDriverName } from "../db/q";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const backupPath = args.find((a) => !a.startsWith("--"));
  const yes = args.includes("--yes");
  const force = args.includes("--force");

  if (!backupPath) {
    console.error("Usage : npm run restore -- <dossier-de-backup> --yes [--force]");
    process.exit(2);
  }

  await restoreBackup({
    backupPath,
    dataDir: dataRoot(),
    databaseUrl: process.env.DATABASE_URL,
    dbDriver: dbDriverName(),
    yes,
    force,
  });

  console.log("\n✓ Restauration terminée.");
}

main().catch((e) => {
  console.error("[restore] ÉCHEC :", (e as Error).message);
  process.exit(1);
});
