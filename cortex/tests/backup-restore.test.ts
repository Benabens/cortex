/**
 * PREUVE DU FILET DE SÉCURITÉ (Produit v1, Phase 0).
 *
 * dump → wipe → restore, avec vérification que les données sont IDENTIQUES :
 *  1. round-trip des FICHIERS du volume (bases, uploads, contenu) via empreintes SHA-256 ;
 *  2. round-trip d'un jeu de données d'un VRAI moteur Postgres (PGlite, Postgres WASM) :
 *     table + lignes créées avant backup, retrouvées après restore ;
 *  3. garde-fous : refus sans --yes, refus si cible non vide, écrasement avec --force ;
 *  4. cas PGlite HORS du volume (archive dédiée pglite.tar.gz).
 *
 * NON couvert ici (impossible sans serveur Postgres + pg_dump sur la machine) :
 * le chemin `pg_dump`/`pg_restore` réseau. Il est implémenté (lib/backup.ts) et
 * documenté dans DEPLOY.md ; à vérifier sur un hôte disposant de libpq/Railway.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createBackup, restoreBackup, sha256File } from "../lib/backup";

type PGliteMod = typeof import("@electric-sql/pglite");

const tmps: string[] = [];
function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
}

after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});

function writeFile(p: string, bytes: Buffer | string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
}

function checksumTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(root, full)] = sha256File(full);
    }
  };
  walk(root);
  return out;
}

test("dump → wipe → restore : fichiers + jeu de données PGlite identiques", async () => {
  const dataDir = mkTmp("cortex-bak-data-");
  const backupDir = mkTmp("cortex-bak-out-");

  // ── contenu de départ : fichiers représentatifs du volume ──────────────────
  writeFile(path.join(dataDir, "cortex.db"), crypto.randomBytes(4096));
  writeFile(path.join(dataDir, "uploads/screenshot.bin"), crypto.randomBytes(2048));
  writeFile(path.join(dataDir, "ml/refs/annale.txt"), "annale de test\n");
  // WAL SQLite : DOIT être inclus (écritures récentes non checkpointées).
  writeFile(path.join(dataDir, "cortex.db-wal"), crypto.randomBytes(64));

  // ── jeu de données Postgres (PGlite) DANS le volume ────────────────────────
  const pgDir = path.join(dataDir, "pgdata");
  const databaseUrl = `pglite://${pgDir}`;
  const { PGlite } = require("@electric-sql/pglite") as PGliteMod;
  {
    const db = new PGlite(pgDir);
    await db.exec(`CREATE SCHEMA IF NOT EXISTS "t_owner_cs-202"`);
    await db.exec(`CREATE TABLE "t_owner_cs-202".items (id int primary key, txt text)`);
    await db.exec(`INSERT INTO "t_owner_cs-202".items VALUES (1,'faiblesse'),(2,'planning'),(3,'exam')`);
    await db.close();
  }

  const before = checksumTree(dataDir);
  assert.ok(before["cortex.db-wal"], "sanity : le WAL existe avant backup");

  // ── BACKUP ─────────────────────────────────────────────────────────────────
  const { dir: bak, manifest } = await createBackup({
    dataDir,
    backupDir,
    databaseUrl,
    dbDriver: "postgres",
    now: new Date("2026-09-08T10:00:00Z"),
    label: "preuve",
    log: () => {},
  });
  assert.ok(fs.existsSync(path.join(bak, "manifest.json")));
  assert.ok(fs.existsSync(path.join(bak, "data.tar.gz")));
  assert.equal(manifest.postgres, null, "PGlite → pas de pg_dump");
  assert.equal(manifest.pglite, null, "PGlite DANS le volume → pas d'archive dédiée");
  // DATABASE_URL ne doit jamais fuiter dans le manifeste
  assert.ok(!JSON.stringify(manifest).includes(pgDir) || manifest.dataDir.sourcePath === dataDir);
  assert.ok(!JSON.stringify(manifest).includes("pglite://"), "pas d'URL de base dans le manifeste");

  // ── refus sans --yes ────────────────────────────────────────────────────────
  await assert.rejects(
    () => restoreBackup({ backupPath: bak, dataDir, databaseUrl, dbDriver: "postgres", yes: false, log: () => {} }),
    /--yes/,
    "doit refuser sans --yes"
  );

  // ── refus si cible non vide (sans --force) ──────────────────────────────────
  await assert.rejects(
    () => restoreBackup({ backupPath: bak, dataDir, databaseUrl, dbDriver: "postgres", yes: true, log: () => {} }),
    /pas vide/,
    "doit refuser une cible non vide sans --force"
  );

  // ── WIPE ─────────────────────────────────────────────────────────────────────
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });

  // ── RESTORE ───────────────────────────────────────────────────────────────────
  await restoreBackup({ backupPath: bak, dataDir, databaseUrl, dbDriver: "postgres", yes: true, log: () => {} });

  // 1) fichiers identiques (WAL inclus : complétude des données)
  const restored = checksumTree(dataDir);
  assert.equal(restored["cortex.db-wal"], before["cortex.db-wal"], "le WAL est restauré à l'identique");
  for (const [rel, hash] of Object.entries(before)) {
    // les fichiers internes de PGlite sont comparés en bloc plus bas (réouverture) ;
    // on vérifie ici surtout les fichiers applicatifs.
    if (rel.startsWith("pgdata/")) continue;
    assert.equal(restored[rel], hash, `empreinte identique après restore : ${rel}`);
  }

  // 2) le jeu de données PGlite survit (réouverture + requête)
  {
    const db = new PGlite(pgDir);
    const r = await db.query(`SELECT id, txt FROM "t_owner_cs-202".items ORDER BY id`);
    await db.close();
    assert.deepEqual(
      r.rows,
      [
        { id: 1, txt: "faiblesse" },
        { id: 2, txt: "planning" },
        { id: 3, txt: "exam" },
      ],
      "les lignes Postgres doivent être identiques après restore"
    );
  }
});

test("--force écrase une cible non vide ; PGlite HORS du volume → archive dédiée", async () => {
  const dataDir = mkTmp("cortex-bak2-data-");
  const backupDir = mkTmp("cortex-bak2-out-");
  const pgDir = mkTmp("cortex-bak2-pg-"); // HORS du volume
  const databaseUrl = `pglite://${pgDir}`;

  writeFile(path.join(dataDir, "cortex.db"), Buffer.from("base v1"));
  const { PGlite } = require("@electric-sql/pglite") as PGliteMod;
  {
    const db = new PGlite(pgDir);
    await db.exec(`CREATE TABLE kv (k text primary key, v text)`);
    await db.exec(`INSERT INTO kv VALUES ('a','1')`);
    await db.close();
  }

  const { dir: bak, manifest } = await createBackup({
    dataDir,
    backupDir,
    databaseUrl,
    dbDriver: "postgres",
    now: new Date("2026-09-08T11:00:00Z"),
    log: () => {},
  });
  assert.ok(manifest.pglite, "PGlite hors volume → archive dédiée dans le manifeste");
  assert.ok(fs.existsSync(path.join(bak, "pglite.tar.gz")));

  // modifie la cible APRÈS le backup, puis restaure avec --force
  fs.writeFileSync(path.join(dataDir, "cortex.db"), Buffer.from("base MODIFIÉE"));
  {
    const db = new PGlite(pgDir);
    await db.exec(`INSERT INTO kv VALUES ('b','2')`);
    await db.close();
  }

  await restoreBackup({
    backupPath: bak,
    dataDir,
    databaseUrl,
    dbDriver: "postgres",
    yes: true,
    force: true,
    log: () => {},
  });

  assert.equal(fs.readFileSync(path.join(dataDir, "cortex.db"), "utf8"), "base v1", "fichier revenu à la version backupée");
  {
    const db = new PGlite(pgDir);
    const r = await db.query<{ k: string; v: string }>(`SELECT k, v FROM kv ORDER BY k`);
    await db.close();
    assert.deepEqual(r.rows, [{ k: "a", v: "1" }], "la ligne ajoutée après backup a disparu (restore l'a écrasée)");
  }
});
