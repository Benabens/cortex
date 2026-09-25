/**
 * FILET DE SÉCURITÉ — sauvegarde & restauration.
 *
 * Deux surfaces à sauvegarder, indépendantes :
 *  1. LE VOLUME `CORTEX_DATA_DIR` (dataRoot()) — bases SQLite, uploads, refs,
 *     exams, contenu. Archivé en `data.tar.gz` (via l'outil système `tar`).
 *  2. LA BASE selon `DATABASE_URL` :
 *     - `postgres://…` → `pg_dump -Fc` (dump logique cohérent, TOUS les schémas
 *       tenant `t_<user>_<cours>` inclus + le schéma `public`) → `postgres.dump`.
 *     - `pglite://<dir>` → Postgres WASM à stockage FICHIER : le dossier est
 *       archivé (s'il est HORS du volume ; dedans, il est déjà dans data.tar.gz).
 *     - absent (dev SQLite) → rien de plus : la base vit dans le volume, déjà
 *       capturée par data.tar.gz.
 *
 * Ce module est SANS EFFET DE BORD à l'import (testable). Les scripts
 * `scripts/backup.ts` / `scripts/restore.ts` en sont de minces enveloppes CLI.
 *
 * SECRETS : `DATABASE_URL` n'est JAMAIS écrit dans le manifeste ni loggé.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export type PgDumpEntry = {
  file: string; // nom relatif dans l'archive de backup
  bytes: number;
  sha256: string;
};

export type BackupManifest = {
  version: 1;
  createdAt: string; // ISO
  dbDriver: string; // sqlite | postgres
  /** dump pg_dump si DATABASE_URL=postgres://… ; sinon null. */
  postgres: PgDumpEntry | null;
  /** dossier PGlite archivé séparément (uniquement s'il est HORS du volume). */
  pglite: PgDumpEntry | null;
  dataDir: {
    /** chemin d'origine (indicatif ; la restauration cible le CORTEX_DATA_DIR courant). */
    sourcePath: string;
    archive: string;
    bytes: number;
    sha256: string;
    excluded: string[];
  };
  tools: { pgDump?: string; tar?: string; node: string };
};

export type CreateBackupOptions = {
  dataDir: string;
  backupDir: string;
  databaseUrl?: string;
  dbDriver: string;
  /** injectable pour les tests (horodatage déterministe). */
  now?: Date;
  label?: string;
  /** journal (défaut : console.log). */
  log?: (msg: string) => void;
};

export type CreateBackupResult = { dir: string; manifest: BackupManifest };

export type RestoreBackupOptions = {
  /** dossier de backup produit par createBackup (contient manifest.json). */
  backupPath: string;
  dataDir: string;
  databaseUrl?: string;
  dbDriver: string;
  /** garde-fou : sans yes=true, la restauration refuse de s'exécuter. */
  yes: boolean;
  /** outrepasse le refus « cible non vide » (écrase). */
  force?: boolean;
  log?: (msg: string) => void;
};

const noop = () => {};

function stamp(d: Date): string {
  // YYYYMMDD-HHMMSS en heure locale, sûr pour un nom de fichier.
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export function sha256File(file: string): string {
  const buf = fs.readFileSync(file);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function toolVersion(bin: string, arg = "--version"): string | undefined {
  try {
    const r = spawnSync(bin, [arg], { encoding: "utf8" });
    if (r.status === 0) return (r.stdout || r.stderr || "").split("\n")[0].trim();
  } catch {
    /* absent */
  }
  return undefined;
}

function hasTool(bin: string): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
    encoding: "utf8",
  });
  return r.status === 0;
}

/** Archive un dossier en tar.gz. `exclude` : motifs tar (verbatim, ancrés `./` si besoin). */
function tarDir(srcDir: string, outFile: string, exclude: string[]): void {
  const args = ["-czf", outFile, "-C", srcDir];
  for (const e of exclude) args.push(`--exclude=${e}`);
  args.push(".");
  const r = spawnSync("tar", args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`tar a échoué (${r.status}) : ${(r.stderr || "").slice(0, 500)}`);
  }
}

/** Extrait un tar.gz dans `destDir` (créé au besoin). */
function untarInto(archive: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync("tar", ["-xzf", archive, "-C", destDir], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`tar -x a échoué (${r.status}) : ${(r.stderr || "").slice(0, 500)}`);
  }
}

function dirIsNonEmpty(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  const entries = fs.readdirSync(dir).filter((e) => e !== "." && e !== "..");
  return entries.length > 0;
}

/** true si `child` est situé à l'intérieur de `parent`. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function pgliteDir(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith("pglite://")) return null;
  const target = databaseUrl.replace(/^pglite:\/\//, "");
  if (target === "memory" || target === "") return null; // en mémoire → rien à archiver
  return path.resolve(target);
}

/**
 * Crée une sauvegarde horodatée dans `backupDir/cortex-backup-<stamp>[-label]/`.
 * Idempotent : chaque appel produit un dossier distinct, n'écrase rien.
 */
export async function createBackup(opts: CreateBackupOptions): Promise<CreateBackupResult> {
  const log = opts.log ?? console.log;
  const now = opts.now ?? new Date();
  const dataDir = path.resolve(opts.dataDir);
  if (!fs.existsSync(dataDir)) {
    throw new Error(`CORTEX_DATA_DIR introuvable : ${dataDir}`);
  }
  const suffix = opts.label ? `-${opts.label.replace(/[^\w.-]+/g, "_")}` : "";
  const outDir = path.join(path.resolve(opts.backupDir), `cortex-backup-${stamp(now)}${suffix}`);
  if (fs.existsSync(outDir)) {
    throw new Error(`Le dossier de backup existe déjà : ${outDir}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  log(`[backup] → ${outDir}`);

  // ── 1) archive du volume ────────────────────────────────────────────────
  // NB : on inclut VOLONTAIREMENT les WAL/SHM SQLite. Contrairement à git (qui
  // les ignore), un backup doit capturer l'état EXACT : le WAL contient les
  // écritures récentes non encore fusionnées dans le .db — les exclure perdrait
  // des données. Seul le dossier de backup lui-même est exclu (anti-récursion).
  const excluded: string[] = [];
  if (isInside(dataDir, opts.backupDir)) {
    excluded.push(`./${path.relative(dataDir, path.resolve(opts.backupDir))}`);
  }
  const dataArchive = path.join(outDir, "data.tar.gz");
  log(`[backup] archive du volume ${dataDir}…`);
  tarDir(dataDir, dataArchive, excluded);

  // ── 2) base ───────────────────────────────────────────────────────────────
  let postgres: PgDumpEntry | null = null;
  let pglite: PgDumpEntry | null = null;
  const url = opts.databaseUrl;

  if (url && url.startsWith("postgres://")) {
    if (!hasTool("pg_dump")) {
      throw new Error(
        "DATABASE_URL=postgres://… mais `pg_dump` est introuvable. " +
          "Installe les outils client PostgreSQL (libpq) sur l'hôte du backup."
      );
    }
    const dumpFile = path.join(outDir, "postgres.dump");
    log(`[backup] pg_dump (format custom, tous schémas)…`);
    // -Fc : format custom (compressé, restaurable sélectivement). URL passée en
    // argument mais JAMAIS loggée. --no-owner/--no-privileges : restaurable sur
    // un rôle différent (Railway).
    const r = spawnSync(
      "pg_dump",
      ["-Fc", "--no-owner", "--no-privileges", "-f", dumpFile, "-d", url],
      { encoding: "utf8" }
    );
    if (r.status !== 0) {
      throw new Error(`pg_dump a échoué (${r.status}) : ${(r.stderr || "").slice(0, 500)}`);
    }
    postgres = {
      file: "postgres.dump",
      bytes: fs.statSync(dumpFile).size,
      sha256: sha256File(dumpFile),
    };
  } else {
    const pdir = url ? pgliteDir(url) : null;
    if (pdir && fs.existsSync(pdir) && !isInside(dataDir, pdir)) {
      // PGlite fichier HORS du volume → archive dédiée. (Dedans → déjà capturé.)
      const pgliteArchive = path.join(outDir, "pglite.tar.gz");
      log(`[backup] archive du dossier PGlite ${pdir}…`);
      tarDir(pdir, pgliteArchive, []);
      pglite = {
        file: "pglite.tar.gz",
        bytes: fs.statSync(pgliteArchive).size,
        sha256: sha256File(pgliteArchive),
      };
    }
  }

  // ── 3) manifeste ────────────────────────────────────────────────────────
  const manifest: BackupManifest = {
    version: 1,
    createdAt: now.toISOString(),
    dbDriver: opts.dbDriver,
    postgres,
    pglite,
    dataDir: {
      sourcePath: dataDir,
      archive: "data.tar.gz",
      bytes: fs.statSync(dataArchive).size,
      sha256: sha256File(dataArchive),
      excluded,
    },
    tools: {
      pgDump: toolVersion("pg_dump"),
      tar: toolVersion("tar"),
      node: process.version,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  log(
    `[backup] terminé : data=${(manifest.dataDir.bytes / 1024).toFixed(0)}Kio` +
      (postgres ? `, postgres=${(postgres.bytes / 1024).toFixed(0)}Kio` : "") +
      (pglite ? `, pglite=${(pglite.bytes / 1024).toFixed(0)}Kio` : "")
  );
  return { dir: outDir, manifest };
}

function readManifest(backupPath: string): BackupManifest {
  const mf = path.join(backupPath, "manifest.json");
  if (!fs.existsSync(mf)) {
    throw new Error(`Manifeste introuvable : ${mf} (le chemin est-il un dossier de backup ?)`);
  }
  return JSON.parse(fs.readFileSync(mf, "utf8")) as BackupManifest;
}

/** Vérifie les empreintes du backup avant de restaurer (détecte une archive corrompue). */
function verifyChecksums(backupPath: string, m: BackupManifest): void {
  const check = (rel: string, want: string) => {
    const p = path.join(backupPath, rel);
    const got = sha256File(p);
    if (got !== want) throw new Error(`Empreinte SHA-256 invalide pour ${rel} (archive corrompue ?)`);
  };
  check(m.dataDir.archive, m.dataDir.sha256);
  if (m.postgres) check(m.postgres.file, m.postgres.sha256);
  if (m.pglite) check(m.pglite.file, m.pglite.sha256);
}

/** true si la base Postgres cible contient déjà des schémas applicatifs. */
function postgresNonEmpty(databaseUrl: string): boolean {
  if (!hasTool("psql")) {
    // Sans psql on ne peut pas mesurer → on considère « non vide » par prudence
    // (la restauration exigera --force). Mieux vaut refuser que d'écraser.
    return true;
  }
  const sql =
    "SELECT count(*) FROM information_schema.schemata " +
    "WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast') " +
    "AND schema_name NOT LIKE 'pg_temp%' AND schema_name NOT LIKE 'pg_toast_temp%';";
  const r = spawnSync("psql", ["-tAqc", sql, "-d", databaseUrl], { encoding: "utf8" });
  if (r.status !== 0) return true; // en cas de doute, on refuse
  const n = Number((r.stdout || "").trim());
  // `public` seul (0 table applicative) ne compte pas comme « occupé ».
  return Number.isFinite(n) && n > 1;
}

/**
 * Restaure une sauvegarde. Garde-fous :
 *  - refuse sans `yes: true` ;
 *  - refuse si la cible (volume ET/OU base Postgres) est déjà peuplée, sauf `force: true`.
 */
export async function restoreBackup(opts: RestoreBackupOptions): Promise<void> {
  const log = opts.log ?? console.log;
  const backupPath = path.resolve(opts.backupPath);
  const dataDir = path.resolve(opts.dataDir);
  const m = readManifest(backupPath);

  if (!opts.yes) {
    throw new Error(
      "Restauration ANNULÉE : passe --yes pour confirmer (opération destructrice)."
    );
  }
  log(`[restore] backup du ${m.createdAt} (driver=${m.dbDriver})`);
  log(`[restore] vérification des empreintes…`);
  verifyChecksums(backupPath, m);

  // ── garde-fou « cible non vide » ──────────────────────────────────────────
  if (!opts.force) {
    if (dirIsNonEmpty(dataDir)) {
      throw new Error(
        `Le volume cible n'est pas vide : ${dataDir}. ` +
          `Vide-le d'abord, ou relance avec --force pour écraser.`
      );
    }
    if (opts.databaseUrl?.startsWith("postgres://") && postgresNonEmpty(opts.databaseUrl)) {
      throw new Error(
        "La base Postgres cible n'est pas vide (schémas applicatifs présents). " +
          "Utilise une base vide, ou relance avec --force."
      );
    }
  }

  // ── 1) volume ──────────────────────────────────────────────────────────────
  log(`[restore] restauration du volume → ${dataDir}…`);
  untarInto(path.join(backupPath, m.dataDir.archive), dataDir);

  // ── 2) PGlite hors volume ──────────────────────────────────────────────────
  if (m.pglite && opts.databaseUrl) {
    const pdir = pgliteDir(opts.databaseUrl);
    if (pdir) {
      log(`[restore] restauration du dossier PGlite → ${pdir}…`);
      if (opts.force && fs.existsSync(pdir)) fs.rmSync(pdir, { recursive: true, force: true });
      untarInto(path.join(backupPath, m.pglite.file), pdir);
    }
  }

  // ── 3) Postgres ────────────────────────────────────────────────────────────
  if (m.postgres && opts.databaseUrl?.startsWith("postgres://")) {
    if (!hasTool("pg_restore")) {
      throw new Error("`pg_restore` introuvable — installe les outils client PostgreSQL (libpq).");
    }
    log(`[restore] pg_restore (--clean --if-exists)…`);
    const r = spawnSync(
      "pg_restore",
      [
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "-d",
        opts.databaseUrl,
        path.join(backupPath, m.postgres.file),
      ],
      { encoding: "utf8" }
    );
    // pg_restore renvoie souvent un status ≠ 0 avec des warnings bénins
    // (« does not exist, skipping ») sur --clean. On échoue seulement sur des
    // erreurs réelles détectées dans stderr.
    const err = r.stderr || "";
    const realErrors = err
      .split("\n")
      .filter((l) => /error:/i.test(l) && !/does not exist, skipping/i.test(l));
    if (r.status !== 0 && realErrors.length) {
      throw new Error(`pg_restore a échoué : ${realErrors.slice(0, 5).join(" | ").slice(0, 800)}`);
    }
  }

  log(`[restore] terminé.`);
}
