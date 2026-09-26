/**
 * VÉRIFICATION d'une sauvegarde — « une sauvegarde jamais vérifiée n'en est pas une ».
 *
 *  1. manifeste présent et empreintes SHA-256 exactes (lib/backup) ;
 *  2. l'archive du volume se liste (`tar -tzf`) et n'est pas vide ;
 *  3. s'il y a un dump Postgres : `pg_restore -l` doit le lire (table des
 *     matières) et y trouver au moins une TABLE — un dump tronqué ou vide est
 *     refusé ici plutôt que découvert le jour de la restauration.
 *
 * Aucune écriture, aucune connexion à une base : exécutable partout où
 * `pg_restore` existe (image de prod, poste avec libpq).
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readManifest, verifyChecksums, type BackupManifest } from "./backup";

export type ExecResult = { status: number | null; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => ExecResult;

export type VerifyResult = {
  manifest: BackupManifest;
  /** entrées de data.tar.gz */
  dataEntries: number;
  /** entrées de la table des matières pg_restore (null sans dump Postgres) */
  pgToc: number | null;
  pgSchemas: string[];
  pgTables: number;
};

const defaultExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { status: null, stdout: "", stderr: r.error.message };
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export async function verifyBackup(dir: string, opts: { log?: (m: string) => void; exec?: Exec } = {}): Promise<VerifyResult> {
  const log = opts.log ?? console.log;
  const exec = opts.exec ?? defaultExec;
  const backupPath = path.resolve(dir);
  const manifest = readManifest(backupPath);
  log(`[backup:verify] ${backupPath} — créé le ${manifest.createdAt} (driver ${manifest.dbDriver})`);

  log("[backup:verify] empreintes SHA-256…");
  verifyChecksums(backupPath, manifest);

  log("[backup:verify] listage de l'archive du volume…");
  const tar = exec("tar", ["-tzf", path.join(backupPath, manifest.dataDir.archive)]);
  if (tar.status !== 0) throw new Error(`tar -t a échoué : ${tar.stderr.slice(0, 300)}`);
  const dataEntries = tar.stdout.split("\n").filter((l) => l.trim() && l.trim() !== "./").length;
  if (dataEntries === 0) throw new Error("L'archive du volume est vide.");

  let pgToc: number | null = null;
  const pgSchemas: string[] = [];
  let pgTables = 0;
  if (manifest.dbDriver === "postgres" && !manifest.postgres && !manifest.pglite) {
    throw new Error("Sauvegarde sans dump Postgres alors que la base est Postgres : le volume seul ne contient ni les comptes ni les crédits — sauvegarde inutilisable.");
  }
  if (manifest.postgres) {
    log("[backup:verify] pg_restore -l (table des matières du dump)…");
    const r = exec("pg_restore", ["-l", path.join(backupPath, manifest.postgres.file)]);
    if (r.status !== 0) {
      throw new Error(`pg_restore -l a échoué (${r.status ?? "introuvable"}) : ${(r.stderr || "pg_restore absent — installe les outils client PostgreSQL").trim().slice(0, 400)}`);
    }
    const entries = r.stdout.split("\n").filter((l) => /^\d+;\s/.test(l));
    pgToc = entries.length;
    for (const l of entries) {
      const m = /^\d+;\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+(\S+)/.exec(l);
      if (!m) continue;
      const [, kind, ns, name] = m;
      if (kind === "SCHEMA") pgSchemas.push(name);
      if (kind === "TABLE" && ns !== "-") pgTables++;
    }
    if (pgTables === 0) throw new Error("Le dump Postgres ne contient aucune table : sauvegarde inutilisable.");
  }
  log(`[backup:verify] OK — volume : ${dataEntries} entrées` + (pgToc !== null ? ` ; dump : ${pgToc} entrées, ${pgTables} tables, schémas ${pgSchemas.join(", ")}` : ""));
  return { manifest, dataEntries, pgToc, pgSchemas, pgTables };
}
