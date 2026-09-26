/**
 * LOT 5 — planificateur : un jour marqué « fait » n'est cru que s'il est PROUVÉ
 * par le compte rendu du script (jour + dossier + dump quand la base est
 * Postgres). Cas de la première sauvegarde de prod : jour marqué par l'ancien
 * code, aucun dump → relancé au tick suivant, par une seule instance.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
(process.env as Record<string, string>).NODE_ENV = "development";

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL"]) delete process.env[k];
});

test("planificateur : jour marqué fait mais sans dump (ou sans compte rendu) → relancé une fois, puis fait", async () => {
  const { dailyBackupTick, recordBackupResult, claimDailyBackup } = await import("../lib/backup-schedule");
  const env = { BACKUP_S3_ENDPOINT: "https://s3.example.test", BACKUP_S3_BUCKET: "b", BACKUP_S3_ACCESS_KEY_ID: "a", BACKUP_S3_SECRET_ACCESS_KEY: "s", BACKUP_HOUR_UTC: "3" };
  const day = "2026-10-01";
  // Situation de prod : l'ancien code a marqué le jour « fait » (aucun compte rendu, pas de dump).
  assert.equal(await claimDailyBackup(day), true);
  let runs = 0;
  const runOkFor = (d: string) => async () => { runs++; await recordBackupResult(d, { postgres: true, folder: `cortex-backup-${runs}` }); return 0; };
  const runOk = runOkFor(day);
  const both = await Promise.all([
    dailyBackupTick({ now: new Date(`${day}T04:00:00Z`), env, run: runOk, expectDump: true }),
    dailyBackupTick({ now: new Date(`${day}T04:00:00Z`), env, run: runOk, expectDump: true }),
  ]);
  assert.deepEqual(both.sort(), ["ok", "skipped:done"], "une seule instance rattrape le jour");
  assert.equal(runs, 1);
  assert.equal(await dailyBackupTick({ now: new Date(`${day}T05:00:00Z`), env, run: runOk, expectDump: true }), "skipped:done", "compte rendu avec dump → rien à refaire");
  // Compte rendu SANS dump alors que la base est Postgres → à refaire.
  const day2 = "2026-10-02";
  const runNoDump = async () => { runs++; await recordBackupResult(day2, { postgres: false, folder: "cortex-backup-sans-dump" }); return 0; };
  assert.equal(await dailyBackupTick({ now: new Date(`${day2}T04:00:00Z`), env, run: runNoDump, expectDump: true }), "failed", "un run « réussi » sans dump est un échec");
  assert.equal(await dailyBackupTick({ now: new Date(`${day2}T05:00:00Z`), env, run: runOkFor(day2), expectDump: true }), "ok");
  // Un run qui ne rend aucun compte rendu est un échec, retenté.
  const day3 = "2026-10-03";
  assert.equal(await dailyBackupTick({ now: new Date(`${day3}T04:00:00Z`), env, run: async () => 0, expectDump: true }), "failed");
  assert.equal(await dailyBackupTick({ now: new Date(`${day3}T05:00:00Z`), env, run: runOkFor(day3), expectDump: true }), "ok");
  // Base sqlite (dev) : pas de dump attendu, un compte rendu sans dump suffit.
  const day4 = "2026-10-04";
  const runSqlite = async () => { await recordBackupResult(day4, { postgres: false, folder: "x" }); return 0; };
  assert.equal(await dailyBackupTick({ now: new Date(`${day4}T04:00:00Z`), env, run: runSqlite, expectDump: false }), "ok");
});

