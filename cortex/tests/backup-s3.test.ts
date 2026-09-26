/**
 * SAUVEGARDES HORS SITE (I12) — preuve sur un FAUX client S3 (en mémoire) :
 *  1. configuration : absente → désactivé ; partielle → erreur nommant les variables ;
 *  2. envoi : chaque fichier du dossier de backup arrive sous <prefix>/<dossier>/,
 *     octets identiques, manifest.json en DERNIER (témoin de complétude) ;
 *  3. rétention : les dossiers plus vieux que BACKUP_KEEP_DAYS sont supprimés,
 *     jamais le plus récent complet, jamais un dossier récent ;
 *  4. vérification : empreintes + listage tar ; dump Postgres → `pg_restore -l`
 *     doit réussir (faux exécuteur), sinon échec explicite ; fichier altéré → échec ;
 *  5. planification quotidienne : un seul déclenchement par jour UTC même avec
 *     deux instances (marqueur en base), pas avant l'heure, relance si échec ;
 *  6. (si CORTEX_TEST_PG_URL + pg_dump) : vrai dump → `pg_restore -l` liste les schémas.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
(process.env as Record<string, string>).NODE_ENV = "development";

import { createBackup } from "../lib/backup";
import { backupS3Config, pushBackup, pruneBackups, listRemoteBackups, pullBackup, type BackupStore, type S3Object } from "../lib/backup-s3";
import { verifyBackup } from "../lib/backup-verify";

const tmps: string[] = [];
function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
}
after(async () => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL"]) delete process.env[k];
});

/** Faux S3 : une Map clé → {corps, date}. `clock` pilote LastModified. */
function fakeStore(clock: { now: Date }) {
  const objects = new Map<string, { body: Buffer; at: Date }>();
  const puts: string[] = [];
  const bodies: string[] = [];
  const store: BackupStore = {
    async put(key, body) {
      // Un dossier de sauvegarde peut peser des Go : le magasin reçoit un fichier (chemin + taille), jamais un tampon entier.
      bodies.push(Buffer.isBuffer(body) ? "buffer" : "file");
      const bytes = Buffer.isBuffer(body) ? Buffer.from(body) : fs.readFileSync(body.path);
      if (!Buffer.isBuffer(body)) assert.equal(bytes.length, body.size, "taille annoncée = taille réelle");
      objects.set(key, { body: bytes, at: new Date(clock.now) }); puts.push(key);
    },
    async list(prefix) {
      const out: S3Object[] = [];
      for (const [key, v] of objects) if (key.startsWith(prefix)) out.push({ key, lastModified: v.at, size: v.body.length });
      return out;
    },
    async remove(keys) { for (const k of keys) objects.delete(k); },
    async get(key) { const v = objects.get(key); if (!v) throw new Error(`NoSuchKey: ${key}`); return v.body; },
  };
  return { store, objects, puts, bodies };
}

const ENV_OK = {
  BACKUP_S3_ENDPOINT: "https://s3.example.test",
  BACKUP_S3_BUCKET: "cortex-bak",
  BACKUP_S3_ACCESS_KEY_ID: "AK",
  BACKUP_S3_SECRET_ACCESS_KEY: "SK",
};

function makeLocalBackup(now: Date, label?: string) {
  const dataDir = mkTmp("cortex-s3-data-");
  const backupDir = mkTmp("cortex-s3-out-");
  fs.writeFileSync(path.join(dataDir, "cortex.db"), crypto.randomBytes(2048));
  fs.mkdirSync(path.join(dataDir, "u/ben"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "u/ben/annale.pdf"), crypto.randomBytes(1024));
  return createBackup({ dataDir, backupDir, dbDriver: "sqlite", now, label, log: () => {} });
}

test("configuration : absente → null ; partielle → erreur listant les variables manquantes", () => {
  assert.equal(backupS3Config({}), null);
  assert.throws(() => backupS3Config({ BACKUP_S3_ENDPOINT: "https://x" }), /BACKUP_S3_BUCKET.*BACKUP_S3_ACCESS_KEY_ID.*BACKUP_S3_SECRET_ACCESS_KEY/);
  const cfg = backupS3Config(ENV_OK)!;
  assert.equal(cfg.region, "auto");
  assert.equal(cfg.keepDays, 14);
  assert.equal(cfg.prefix, "cortex/");
  const cfg2 = backupS3Config({ ...ENV_OK, BACKUP_S3_REGION: "eu-west-1", BACKUP_KEEP_DAYS: "3", BACKUP_S3_PREFIX: "/prod/bak" })!;
  assert.equal(cfg2.region, "eu-west-1");
  assert.equal(cfg2.keepDays, 3);
  assert.equal(cfg2.prefix, "prod/bak/");
  assert.throws(() => backupS3Config({ ...ENV_OK, BACKUP_KEEP_DAYS: "0" }), /BACKUP_KEEP_DAYS/);
});

test("envoi : fichiers sous <prefix>/<dossier>/, octets identiques, manifest en dernier", async () => {
  const clock = { now: new Date("2026-09-26T03:00:00Z") };
  const { store, objects, puts, bodies } = fakeStore(clock);
  const cfg = backupS3Config(ENV_OK)!;
  const { dir } = await makeLocalBackup(clock.now);
  const res = await pushBackup(store, cfg, dir, { log: () => {} });
  assert.ok(bodies.length > 0 && bodies.every((b) => b === "file"), "envoi en flux (chemin + taille), jamais tout le fichier en mémoire");
  assert.equal(res.folder, path.basename(dir));
  const expected = ["data.tar.gz", "manifest.json"].map((f) => `cortex/${res.folder}/${f}`).sort();
  assert.deepEqual([...objects.keys()].sort(), expected);
  for (const f of ["data.tar.gz", "manifest.json"]) {
    assert.ok(objects.get(`cortex/${res.folder}/${f}`)!.body.equals(fs.readFileSync(path.join(dir, f))), `${f} identique`);
  }
  assert.equal(puts.at(-1), `cortex/${res.folder}/manifest.json`, "manifest.json envoyé en dernier");
  // Rapatriement : le dossier redescend à l'identique.
  const dest = mkTmp("cortex-s3-pull-");
  await pullBackup(store, cfg, res.folder, dest, { log: () => {} });
  assert.ok(fs.readFileSync(path.join(dest, "manifest.json")).equals(fs.readFileSync(path.join(dir, "manifest.json"))));
});

test("rétention : supprime au-delà de BACKUP_KEEP_DAYS, garde le plus récent complet", async () => {
  const clock = { now: new Date("2026-09-01T03:00:00Z") };
  const { store, objects } = fakeStore(clock);
  const cfg = backupS3Config({ ...ENV_OK, BACKUP_KEEP_DAYS: "2" })!;
  const folders: string[] = [];
  for (const day of [1, 2, 3, 5]) {
    clock.now = new Date(`2026-09-0${day}T03:00:00Z`);
    const { dir } = await makeLocalBackup(clock.now, `j${day}`);
    folders.push((await pushBackup(store, cfg, dir, { log: () => {} })).folder);
  }
  // Un dossier INCOMPLET ancien (sans manifest) doit aussi partir.
  objects.set("cortex/cortex-backup-20260101-000000-tronque/data.tar.gz", { body: Buffer.from("x"), at: new Date("2026-01-01T00:00:00Z") });

  // Rétention 2 j vue du 5 sept. 02:00 UTC : j3 (3 sept. 03:00) a 1,96 j → gardé ; j1, j2 → supprimés.
  const now = new Date("2026-09-05T02:00:00Z");
  const before = await listRemoteBackups(store, cfg);
  assert.deepEqual(before.map((b) => [b.folder, b.complete]), [
    [folders[3], true], [folders[2], true], [folders[1], true], [folders[0], true], ["cortex-backup-20260101-000000-tronque", false],
  ]);
  const deleted = await pruneBackups(store, cfg, now, { log: () => {} });
  assert.deepEqual(deleted.sort(), [folders[0], folders[1], "cortex-backup-20260101-000000-tronque"].sort());
  const remaining = new Set([...objects.keys()].map((k) => k.split("/")[1]));
  assert.deepEqual([...remaining].sort(), [folders[2], folders[3]].sort());

  // Tout est vieux → le plus récent complet survit quand même.
  const later = new Date("2026-12-01T00:00:00Z");
  const deleted2 = await pruneBackups(store, cfg, later, { log: () => {} });
  assert.deepEqual(deleted2, [folders[2]]);
  assert.ok([...objects.keys()].every((k) => k.startsWith(`cortex/${folders[3]}/`)));
});

test("vérification : empreintes + tar ; pg_restore -l exigé pour un dump ; altération détectée", async () => {
  const { dir, manifest } = await makeLocalBackup(new Date("2026-09-26T03:00:00Z"));
  const ok = await verifyBackup(dir, { log: () => {} });
  assert.equal(ok.dataEntries >= 3, true, "l'archive liste les fichiers du volume");
  assert.equal(ok.pgToc, null);

  // Dump Postgres simulé : la vérification DOIT appeler pg_restore -l et lire sa sortie.
  const dumpDir = mkTmp("cortex-s3-dump-");
  fs.cpSync(dir, dumpDir, { recursive: true });
  fs.writeFileSync(path.join(dumpDir, "postgres.dump"), Buffer.from("PGDMP-fake"));
  const m = { ...manifest, postgres: { file: "postgres.dump", bytes: 10, sha256: crypto.createHash("sha256").update("PGDMP-fake").digest("hex") } };
  fs.writeFileSync(path.join(dumpDir, "manifest.json"), JSON.stringify(m));
  const calls: string[][] = [];
  const TAR_OK = { status: 0, stdout: "./\n./cortex.db\n./u/\n./u/ben/annale.pdf\n", stderr: "" };
  const toc = [";", "; Archive created at 2026-09-26", ";", "5; 2615 16389 SCHEMA - public postgres", "6; 2615 16400 SCHEMA - t_ben_analyse postgres", "210; 1259 16391 TABLE public users postgres", "211; 1259 16401 TABLE t_ben_analyse jobs postgres"].join("\n");
  const r = await verifyBackup(dumpDir, {
    log: () => {},
    exec: (cmd, args) => { calls.push([cmd, ...args]); return cmd === "pg_restore" ? { status: 0, stdout: toc, stderr: "" } : TAR_OK; },
  });
  assert.ok(calls.some((c) => c[0] === "pg_restore" && c.includes("-l")), "pg_restore -l appelé");
  assert.equal(r.pgToc, 4);
  assert.deepEqual(r.pgSchemas, ["public", "t_ben_analyse"]);
  assert.deepEqual(r.pgTables, 2);

  await assert.rejects(
    verifyBackup(dumpDir, { log: () => {}, exec: (cmd) => (cmd === "pg_restore" ? { status: 1, stdout: "", stderr: "pg_restore: error: input file does not appear to be a valid archive" } : TAR_OK) }),
    /pg_restore.*valid archive/,
  );
  await assert.rejects(
    verifyBackup(dumpDir, { log: () => {}, exec: (cmd) => (cmd === "pg_restore" ? { status: 0, stdout: "5; 2615 16389 SCHEMA - public postgres", stderr: "" } : TAR_OK) }),
    /aucune table/i,
  );

  fs.appendFileSync(path.join(dir, "data.tar.gz"), "corruption");
  await assert.rejects(verifyBackup(dir, { log: () => {} }), /SHA-256/);
});

test("planification : un seul déclenchement par jour UTC (deux instances), pas avant l'heure, relance après échec", async () => {
  const { dailyBackupTick } = await import("../lib/backup-schedule");
  const env = { ...ENV_OK, BACKUP_HOUR_UTC: "3" };
  let runs = 0;
  const run = async () => { runs++; return 0; };

  assert.equal(await dailyBackupTick({ now: new Date("2026-09-26T02:59:00Z"), env, run }), "skipped:too-early");
  assert.equal(await dailyBackupTick({ now: new Date("2026-09-26T03:00:00Z"), env: {}, run }), "skipped:not-configured");
  assert.equal(runs, 0);

  // Deux instances au même instant : une seule gagne le marqueur.
  const both = await Promise.all([
    dailyBackupTick({ now: new Date("2026-09-26T03:00:00Z"), env, run }),
    dailyBackupTick({ now: new Date("2026-09-26T03:00:00Z"), env, run }),
  ]);
  assert.deepEqual(both.sort(), ["ok", "skipped:done"]);
  assert.equal(runs, 1);
  assert.equal(await dailyBackupTick({ now: new Date("2026-09-26T23:00:00Z"), env, run }), "skipped:done");
  assert.equal(runs, 1);

  // Lendemain : échec → le marqueur est rendu, le tick suivant réessaie.
  assert.equal(await dailyBackupTick({ now: new Date("2026-09-27T03:10:00Z"), env, run: async () => 1 }), "failed");
  assert.equal(await dailyBackupTick({ now: new Date("2026-09-27T04:10:00Z"), env, run }), "ok");
  assert.equal(runs, 2);
});

const PG_URL = process.env.CORTEX_TEST_PG_URL;
const hasPgDump = spawnSync("pg_dump", ["--version"], { encoding: "utf8" }).status === 0;
test("vrai Postgres : pg_dump → verify (pg_restore -l) liste public + tenants", { skip: !PG_URL || !hasPgDump ? "CORTEX_TEST_PG_URL ou pg_dump absent" : false }, async () => {
  assert.ok(!/cortexprod/.test(PG_URL!), "jamais la base de production");
  const psql = (sql: string) => spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-Atqc", sql, "-d", PG_URL!], { encoding: "utf8" });
  assert.equal(psql("CREATE SCHEMA IF NOT EXISTS t_test_backup; CREATE TABLE IF NOT EXISTS t_test_backup.jobs (id int); INSERT INTO t_test_backup.jobs VALUES (1)").status, 0);
  try {
    const dataDir = mkTmp("cortex-s3-pgdata-");
    fs.writeFileSync(path.join(dataDir, "x.bin"), "x");
    const { dir } = await createBackup({ dataDir, backupDir: mkTmp("cortex-s3-pgout-"), dbDriver: "postgres", databaseUrl: PG_URL, log: () => {} });
    const r = await verifyBackup(dir, { log: () => {} });
    assert.ok((r.pgToc ?? 0) > 0);
    assert.ok(r.pgSchemas.includes("t_test_backup"), `schémas : ${r.pgSchemas.join(",")}`);
    assert.ok(r.pgTables >= 1);
  } finally {
    psql("DROP SCHEMA IF EXISTS t_test_backup CASCADE");
  }
});

before(() => { /* rien : PGlite s'initialise à la première requête du planificateur */ });
