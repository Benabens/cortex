/**
 * MIGRATION volume → seau des fichiers de cours (lib/storage/migrate).
 *
 * À blanc par défaut : affiche ce qui serait envoyé, n'écrit rien.
 *   npm run storage:migrate                      # plan
 *   npm run storage:migrate -- --write           # envoie, puis vérifie les empreintes
 *   npm run storage:migrate -- --verify          # vérifie seulement (relit chaque objet)
 *   npm run storage:migrate -- --only=u/<compte> # un sous-dossier
 *
 * Lit STORAGE_S3_* (comme l'app) et CORTEX_DATA_DIR. Idempotent, ne supprime rien.
 * Code de sortie 1 si une empreinte diffère ou si un objet manque. Détail : DEPLOY.md.
 */
import { dataRoot } from "../lib/courses";
import { storageS3Config } from "../lib/storage";
import { sdkBucket } from "../lib/storage/bucket";
import { migrateToBucket, verifyBucket } from "../lib/storage/migrate";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const only = args.find((a) => a.startsWith("--only="))?.slice("--only=".length).replace(/^\/+|\/+$/g, "") || undefined;

async function main(): Promise<void> {
  const cfg = storageS3Config();
  if (!cfg) throw new Error("STORAGE_S3_BUCKET, STORAGE_S3_ENDPOINT, STORAGE_S3_ACCESS_KEY_ID et STORAGE_S3_SECRET_ACCESS_KEY doivent être posés.");
  if (only && only.split("/").includes("..")) throw new Error("--only : chemin relatif au dossier de données, sans « .. ».");
  const opts = { bucket: sdkBucket(cfg), root: dataRoot(), prefix: cfg.prefix, only };
  console.log(`[storage:migrate] ${dataRoot()} → s3://${cfg.bucket}/${cfg.prefix}${only ?? ""}`);
  const verify = flag("--verify") && !flag("--write")
    ? await verifyBucket(opts)
    : (await migrateToBucket({ ...opts, write: flag("--write") })).verify;
  if (verify && (verify.mismatched.length || verify.missing.length)) process.exit(1);
}

main().catch((e) => {
  console.error(`[storage:migrate] échec : ${(e as Error)?.message ?? e}`);
  process.exit(1);
});
