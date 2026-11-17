/**
 * AUDIT FUITES DU 17/11, I13 — une sauvegarde ratée ne laissait qu'une ligne de journal : on
 * découvrait l'absence de sauvegarde le jour où il fallait restaurer. Désormais :
 *  - un échec prévient Sentry (une alerte par 6 h au plus, le tick retente toutes les 30 min) ;
 *  - le détail de /api/health (jeton METRICS_TOKEN) donne l'âge de la dernière sauvegarde
 *    prouvée ; la réponse publique ne change pas (la sonde de Railway ne doit pas redémarrer
 *    le site pour une sauvegarde en retard).
 *
 * Seams : backup-schedule dailyBackupTick, GET /api/health.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
(process.env as Record<string, string>).NODE_ENV = "development";

type Captured = { e: unknown; tags: Record<string, string> };
const captured: Captured[] = [];
const ENV = { BACKUP_S3_ENDPOINT: "https://s3.example.test", BACKUP_S3_BUCKET: "b", BACKUP_S3_ACCESS_KEY_ID: "a", BACKUP_S3_SECRET_ACCESS_KEY: "s", BACKUP_HOUR_UTC: "3" };

before(async () => {
  process.env.SENTRY_DSN = "https://exemple@o0.ingest.sentry.io/1";
  const { initErrorTracking } = await import("../lib/observability");
  await initErrorTracking({
    load: async () => ({
      init: () => {},
      captureException: (e: unknown, hint?: Record<string, unknown>) => { captured.push({ e, tags: (hint?.tags ?? {}) as Record<string, string> }); },
    }),
  });
});
beforeEach(async () => {
  captured.length = 0;
  const { resetErrorTrackingThrottleForTests } = await import("../lib/observability");
  resetErrorTrackingThrottleForTests();
});
after(async () => {
  const { resetErrorTrackingForTests } = await import("../lib/observability");
  resetErrorTrackingForTests();
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL", "SENTRY_DSN", "METRICS_TOKEN"]) delete process.env[k];
});

test("I13 : sauvegarde en échec → Sentry prévenu, une fois pour plusieurs ticks ratés", async () => {
  const { dailyBackupTick } = await import("../lib/backup-schedule");
  const day = "2026-11-10";
  for (const h of ["04", "04", "05"]) {
    assert.equal(await dailyBackupTick({ now: new Date(`${day}T${h}:00:00Z`), env: ENV, run: async () => 1, expectDump: true, log: () => {} }), "failed");
  }
  const alerts = captured.filter((c) => c.tags.area === "backup");
  assert.equal(alerts.length, 1, JSON.stringify(captured.map((c) => c.tags)));
  assert.equal(alerts[0].tags.alert, "backup_failed");
});

test("I13 : sauvegarde réussie → aucune alerte", async () => {
  const { dailyBackupTick, recordBackupResult } = await import("../lib/backup-schedule");
  const day = "2026-11-11";
  const ok = async () => { await recordBackupResult(day, { postgres: true, folder: "cortex-backup-ok" }); return 0; };
  assert.equal(await dailyBackupTick({ now: new Date(`${day}T04:00:00Z`), env: ENV, run: ok, expectDump: true, log: () => {} }), "ok");
  assert.equal(captured.filter((c) => c.tags.area === "backup").length, 0);
});

test("I13 : /api/health avec jeton donne l'âge de la dernière sauvegarde ; sans jeton, rien de plus", async () => {
  process.env.METRICS_TOKEN = "jeton-de-test-assez-long-0123456789";
  const { recordBackupResult } = await import("../lib/backup-schedule");
  await recordBackupResult("2026-11-12", { postgres: true, folder: "cortex-backup-12" });
  const { GET } = await import("../app/api/health/route");
  const detailed = await (await GET(new Request("http://localhost/api/health", { headers: { authorization: `Bearer ${process.env.METRICS_TOKEN}` } }))).json();
  assert.equal(detailed.checks.backup.lastDay, "2026-11-12");
  assert.equal(typeof detailed.checks.backup.ageHours, "number");
  assert.ok(detailed.checks.backup.ageHours < 1, "compte rendu écrit à l'instant");
  assert.equal(detailed.checks.backup.fresh, true);
  const pub = await (await GET(new Request("http://localhost/api/health"))).json();
  assert.deepEqual(Object.keys(pub).sort(), ["commit", "status"]);
});
