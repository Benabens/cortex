/**
 * LOT 5 — la première sauvegarde de prod n'avait PAS de dump : Railway fournit
 * DATABASE_URL=postgresql://… et le code ne reconnaissait que postgres://.
 *  1. postgres:// ET postgresql:// sont reconnus partout ;
 *  2. base Postgres sans dump produit → la sauvegarde ÉCHOUE (aucun manifeste) ;
 *  3. backup:verify refuse une sauvegarde sans dump quand dbDriver=postgres ;
 *  4. planificateur : un jour « fait » sans dump (ou sans compte rendu) est
 *     considéré non fait et relancé au tick suivant — une seule instance relance ;
 *  5. (cortextest) URL postgresql:// réelle → pg_dump produit un dump vérifiable.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
(process.env as Record<string, string>).NODE_ENV = "development";

const tmps: string[] = [];
const mkTmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmps.push(d); return d; };
after(async () => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL"]) delete process.env[k];
});

test("isPostgresUrl : postgres:// et postgresql://, pas pglite ni sqlite", async () => {
  const { isPostgresUrl } = await import("../lib/backup");
  assert.equal(isPostgresUrl("postgres://u@h/db"), true);
  assert.equal(isPostgresUrl("postgresql://u@h/db"), true);
  assert.equal(isPostgresUrl("pglite://memory"), false);
  assert.equal(isPostgresUrl(undefined), false);
  const src = fs.readFileSync("lib/backup.ts", "utf8") + fs.readFileSync("lib/backup-verify.ts", "utf8") + fs.readFileSync("lib/backup-schedule.ts", "utf8") + fs.readFileSync("scripts/backup.ts", "utf8");
  assert.ok(!/startsWith\("postgres:\/\/"\)/.test(src), "plus aucun test de préfixe postgres:// nu");
});

test("base Postgres sans dump produit → échec bruyant, aucun manifeste", async () => {
  const { createBackup } = await import("../lib/backup");
  const dataDir = mkTmp("cortex-pgurl-data-");
  fs.writeFileSync(path.join(dataDir, "x"), "x");
  const backupDir = mkTmp("cortex-pgurl-out-");
  // URL postgresql:// injoignable : pg_dump absent OU échec de connexion, dans les deux cas pas de dump.
  await assert.rejects(
    createBackup({ dataDir, backupDir, dbDriver: "postgres", databaseUrl: "postgresql://nobody@127.0.0.1:1/nope", log: () => {} }),
    /pg_dump|dump/i,
  );
  const dirs = fs.readdirSync(backupDir);
  assert.ok(dirs.every((d) => !fs.existsSync(path.join(backupDir, d, "manifest.json"))), "aucun manifeste « OK » pour une sauvegarde sans dump");
  // Et même sans URL du tout, un driver postgres n'a pas de sauvegarde valable sans dump.
  await assert.rejects(createBackup({ dataDir, backupDir: mkTmp("cortex-pgurl-out2-"), dbDriver: "postgres", log: () => {} }), /dump|DATABASE_URL/i);
});

test("backup:verify refuse une sauvegarde dbDriver=postgres sans dump", async () => {
  const { createBackup } = await import("../lib/backup");
  const { verifyBackup } = await import("../lib/backup-verify");
  const dataDir = mkTmp("cortex-pgurl-data2-");
  fs.writeFileSync(path.join(dataDir, "x"), "x");
  const { dir } = await createBackup({ dataDir, backupDir: mkTmp("cortex-pgurl-out3-"), dbDriver: "sqlite", log: () => {} });
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ ...m, dbDriver: "postgres" }));
  await assert.rejects(verifyBackup(dir, { log: () => {} }), /sans dump|dump Postgres/i);
});

const PG_URL = process.env.CORTEX_TEST_PG_URL;
const hasPgDump = spawnSync("pg_dump", ["--version"], { encoding: "utf8" }).status === 0;
test("cortextest : URL postgresql:// réelle → dump produit et vérifié", { skip: !PG_URL || !hasPgDump ? "CORTEX_TEST_PG_URL ou pg_dump absent" : false }, async () => {
  assert.ok(!/cortexprod/.test(PG_URL!));
  const url = PG_URL!.replace(/^postgres:\/\//, "postgresql://");
  assert.ok(url.startsWith("postgresql://"));
  const { createBackup } = await import("../lib/backup");
  const { verifyBackup } = await import("../lib/backup-verify");
  const psql = (sql: string) => spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-Atqc", sql, "-d", url], { encoding: "utf8" });
  assert.equal(psql("CREATE SCHEMA IF NOT EXISTS t_test_pgurl; CREATE TABLE IF NOT EXISTS t_test_pgurl.jobs (id int); INSERT INTO t_test_pgurl.jobs VALUES (1)").status, 0);
  try {
    const dataDir = mkTmp("cortex-pgurl-real-");
    fs.writeFileSync(path.join(dataDir, "x"), "x");
    const { manifest, dir } = await createBackup({ dataDir, backupDir: mkTmp("cortex-pgurl-realout-"), dbDriver: "postgres", databaseUrl: url, log: () => {} });
    assert.ok(manifest.postgres && manifest.postgres.bytes > 0, "dump présent");
    const r = await verifyBackup(dir, { log: () => {} });
    assert.ok(r.pgSchemas.includes("t_test_pgurl"));
  } finally { psql("DROP SCHEMA IF EXISTS t_test_pgurl CASCADE"); }
});
