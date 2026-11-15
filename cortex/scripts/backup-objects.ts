/**
 * RESTAURATION des objets du seau de fichiers depuis une sauvegarde (lib/backup-objects).
 *
 * Le dossier de sauvegarde (rapatrié par `npm run backup:verify -- --latest --keep=…`
 * ou `--remote=<dossier> --keep=…`) porte l'index du seau (objects.json) ; les
 * contenus sont lus dans le stockage de sauvegarde (BACKUP_S3_*), empreinte vérifiée.
 *
 *   npm run backup:objects -- <dossier> --to=<dossier-cible>      # essai : fichiers sur disque
 *   npm run backup:objects -- <dossier> --to-bucket --yes         # sinistre : remplit le seau STORAGE_S3_*
 *   npm run backup:objects -- <dossier> --to-bucket --yes --force # même si le seau n'est pas vide
 *
 * Un objet supprimé du seau se restaure depuis une sauvegarde d'avant sa
 * suppression (retenue 14 j) : `npm run backup:verify -- --list` pour choisir.
 * Code de sortie 1 si un contenu manque ou si une empreinte diffère.
 */
import path from "node:path";
import { readManifest, verifyChecksums } from "../lib/backup";
import { readLocalIndex, restoreObjects } from "../lib/backup-objects";
import { backupS3Config, s3Store } from "../lib/backup-s3";
import { storageS3Config } from "../lib/storage";
import { sdkBucket } from "../lib/storage/bucket";

const args = process.argv.slice(2);
const hasFlag = (f: string) => args.includes(f);
const argValue = (flag: string) => { const hit = args.find((a) => a.startsWith(`${flag}=`)); return hit ? hit.slice(flag.length + 1) : undefined; };

async function main(): Promise<void> {
  const dir = args.find((a) => !a.startsWith("--"));
  const toDir = argValue("--to");
  if (!dir || (!toDir && !hasFlag("--to-bucket"))) {
    throw new Error("Usage : npm run backup:objects -- <dossier-de-sauvegarde> --to=<dossier> | --to-bucket --yes [--force]");
  }
  const manifest = readManifest(path.resolve(dir));
  const entry = manifest.objectStore?.index;
  if (!entry) throw new Error("Cette sauvegarde ne porte pas d'index des objets du seau (stockage objet inactif ce jour-là, ou sauvegarde sans --push).");
  verifyChecksums(path.resolve(dir), manifest);
  const index = readLocalIndex(dir, entry)!;

  const cfg = backupS3Config();
  if (!cfg) throw new Error("BACKUP_S3_* non posés : les contenus sont dans le stockage de sauvegarde.");
  const store = s3Store(cfg);
  console.log(`[backup:objets] sauvegarde du ${manifest.createdAt} : ${entry.objects} objet(s), ${(entry.bytes / 1024 / 1024).toFixed(1)} Mo`);

  if (toDir) {
    const r = await restoreObjects({ store, cfg, index, toDir: path.resolve(toDir) });
    console.log(`\n✓ ${r.restored} objet(s) restauré(s) dans ${path.resolve(toDir)}, empreintes vérifiées.`);
    return;
  }
  if (!hasFlag("--yes")) throw new Error("Restauration dans le seau ANNULÉE : passe --yes pour confirmer.");
  const files = storageS3Config();
  if (!files) throw new Error("STORAGE_S3_* non posés : aucun seau de fichiers à remplir.");
  const target = sdkBucket(files);
  if (!hasFlag("--force") && (await target.list(files.prefix)).length) {
    throw new Error(`Le seau ${files.bucket}/${files.prefix} n'est pas vide : vide-le, ou relance avec --force (écrase les clés de l'index).`);
  }
  const r = await restoreObjects({ store, cfg, index, toBucket: { bucket: target, prefix: files.prefix } });
  console.log(`\n✓ ${r.restored} objet(s) restauré(s) dans s3://${files.bucket}/${files.prefix}, empreintes vérifiées.`);
}

main().catch((e) => {
  console.error("[backup:objets] ÉCHEC :", (e as Error).message);
  process.exit(1);
});
