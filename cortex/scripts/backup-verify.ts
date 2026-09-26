/**
 * VÉRIFICATION d'une sauvegarde — empreintes, listage de l'archive du volume,
 * et `pg_restore -l` sur le dump Postgres (table des matières : schémas, tables).
 *
 * Usage :
 *   npm run backup:verify -- ./backups/cortex-backup-<horodatage>
 *   npm run backup:verify -- --latest        # rapatrie la plus récente depuis S3 (BACKUP_S3_*)
 *   npm run backup:verify -- --remote=<dossier>
 *   npm run backup:verify -- --list          # liste les sauvegardes distantes
 *
 * Code de sortie ≠ 0 si la sauvegarde est inutilisable. Rien n'est restauré.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backupS3Config, listRemoteBackups, pullBackup, s3Store } from "../lib/backup-s3";
import { verifyBackup } from "../lib/backup-verify";

const args = process.argv.slice(2);
const hasFlag = (f: string) => args.includes(f);
const argValue = (flag: string) => { const hit = args.find((a) => a.startsWith(`${flag}=`)); return hit ? hit.slice(flag.length + 1) : undefined; };

async function main(): Promise<void> {
  const remote = hasFlag("--latest") || hasFlag("--list") || argValue("--remote");
  let dir = args.find((a) => !a.startsWith("--"));
  let tmp: string | null = null;

  if (remote) {
    const cfg = backupS3Config();
    if (!cfg) throw new Error("BACKUP_S3_* non posés : impossible d'atteindre le stockage distant.");
    const store = s3Store(cfg);
    const all = await listRemoteBackups(store, cfg);
    if (hasFlag("--list")) {
      if (!all.length) console.log("Aucune sauvegarde distante.");
      for (const b of all) console.log(`${b.complete ? "✓" : "✗ incomplet"}  ${b.folder}  ${b.createdAt.toISOString()}  ${(b.bytes / 1024 / 1024).toFixed(1)} Mo`);
      if (!hasFlag("--latest") && !argValue("--remote")) return;
    }
    const folder = argValue("--remote") ?? all.find((b) => b.complete)?.folder;
    if (!folder) throw new Error("Aucune sauvegarde distante complète à vérifier.");
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-verify-"));
    dir = await pullBackup(store, cfg, folder, path.join(tmp, folder));
  }
  if (!dir) throw new Error("Indique un dossier de sauvegarde, ou --latest / --remote=<dossier> avec BACKUP_S3_*.");

  try {
    const r = await verifyBackup(dir);
    console.log(`\n✓ Sauvegarde vérifiée : ${path.basename(dir)} (créée le ${r.manifest.createdAt})`);
    console.log(`  volume : ${r.dataEntries} entrées`);
    if (r.pgToc !== null) console.log(`  dump   : ${r.pgTables} tables, schémas ${r.pgSchemas.join(", ")}`);
    else console.log(`  dump   : aucun (base SQLite/PGlite incluse dans le volume)`);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("[backup:verify] ÉCHEC :", (e as Error).message);
  process.exit(1);
});
