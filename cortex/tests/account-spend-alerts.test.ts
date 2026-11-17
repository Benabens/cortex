/**
 * ALERTE DE DÉPENSE PAR COMPTE ET PAR HEURE (audit fuites P7, lib/billing/account-spend-alerts) :
 * au-delà de SPEND_ALERT_PER_USER_HOUR_USD dans l'heure UTC, un journal
 * `spend_alert.account_hour` (et un événement Sentry quand il est actif), une seule
 * fois par compte et par heure, même pour un process neuf ; jamais pour le propriétaire.
 *
 * Base : PGlite (le dialecte de la prod), horloge pilotée.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-alerte-compte-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
(process.env as Record<string, string>).NODE_ENV = "development";

const ENV_KEYS = ["SPEND_ALERT_PER_USER_HOUR_USD", "SPEND_CAP_USD", "SPEND_CAP_PER_USER_USD", "AUTH_ENABLED", "BILLING_ENABLED", "CORTEX_OWNER_EMAIL", "CORTEX_OWNER_USER_ID"];

let usage: typeof import("../lib/billing/usage");
let alerts: typeof import("../lib/billing/account-spend-alerts");
let currentUser: typeof import("../db/context").currentUser;

before(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  usage = await import("../lib/billing/usage");
  alerts = await import("../lib/billing/account-spend-alerts");
  ({ currentUser } = await import("../db/context"));
  const { authRun } = await import("../db/auth-store");
  await authRun("SELECT 1");
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of [...ENV_KEYS, "DB_DRIVER", "DATABASE_URL", "CORTEX_DATA_DIR"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  usage.resetSpendCache();
});

/** Un appel payant de `usd` dollars (Sonnet : 2 $ par MTok en entrée). */
const spend = (usd: number) => usage.recordUsage({ provider: "anthropic", model: "claude-sonnet-5", tokensIn: usd * 500_000 });

/** Journaux `spend_alert.account_hour` émis pendant `fn`. */
async function hourAlerts(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const lines: string[] = [];
  console.log = console.error = console.warn = (s: unknown) => { lines.push(String(s)); };
  try { await fn(); } finally { Object.assign(console, orig); }
  return lines
    .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
    .filter((o): o is Record<string, unknown> => !!o && o.evt === "spend_alert.account_hour");
}

test("seuil : défaut 5 $ en déploiement gardé, jamais au-dessus du fusible du jour, coupé hors garde ou par `unlimited`", () => {
  assert.equal(alerts.accountHourAlertUsd(), null, "dev nu : aucune alerte");
  process.env.AUTH_ENABLED = "1";
  assert.equal(alerts.accountHourAlertUsd(), 5);
  process.env.SPEND_CAP_PER_USER_USD = "3";
  assert.equal(alerts.accountHourAlertUsd(), 3, "le seuil ne dépasse pas le fusible du jour");
  process.env.SPEND_ALERT_PER_USER_HOUR_USD = "unlimited";
  assert.equal(alerts.accountHourAlertUsd(), null);
});

test("une alerte par compte et par heure, même pour un process neuf ; l'heure suivante réarme", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2027, 0, 10, 12, 5, 0) });
  process.env.SPEND_ALERT_PER_USER_HOUR_USD = "5";

  assert.deepEqual(await hourAlerts(() => spend(4)), [], "sous le seuil : rien");
  const first = await hourAlerts(() => spend(2));
  assert.equal(first.length, 1);
  assert.equal(first[0].userId, currentUser());
  assert.equal(first[0].hour, "2027-01-10 12:00 UTC");
  assert.equal(first[0].spent, 6);
  assert.equal(first[0].threshold, 5);

  assert.deepEqual(await hourAlerts(() => spend(2)), [], "même process : déjà signalé");
  usage.resetSpendCache(); // process neuf (un worker par job)
  assert.deepEqual(await hourAlerts(() => spend(2)), [], "process neuf : la clé est réclamée en base");

  t.mock.timers.setTime(Date.UTC(2027, 0, 10, 13, 0, 1));
  assert.deepEqual(await hourAlerts(() => spend(4)), [], "heure neuve : la dépense repart de zéro");
  assert.equal((await hourAlerts(() => spend(1.5))).length, 1, "heure neuve : nouvelle alerte");
});

test("le propriétaire n'est pas suivi (exempté du fusible par compte)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2027, 1, 10, 9, 0, 0) });
  process.env.SPEND_ALERT_PER_USER_HOUR_USD = "1";
  process.env.CORTEX_OWNER_USER_ID = currentUser();
  assert.deepEqual(await hourAlerts(() => spend(3)), []);
});
