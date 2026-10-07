/**
 * Alertes de dépense sur SQLite (le store du dev local) : la réclamation d'un
 * seuil y passe par les mêmes requêtes qu'en Postgres, et doit y tenir aussi.
 * Le reste des comportements est couvert sur PGlite (spend-cap-monthly.test.ts).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-alertes-sqlite-"));
process.env.CORTEX_DATA_DIR = tmp;
const ENV_KEYS = ["DB_DRIVER", "DATABASE_URL", "SPEND_CAP_USD", "SPEND_CAP_PER_USER_USD", "AUTH_ENABLED", "BILLING_ENABLED", "RESEND_API_KEY", "CORTEX_OWNER_EMAIL", "PUBLISHER_EMAIL"];

let usage: typeof import("../lib/billing/usage");
before(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  usage = await import("../lib/billing/usage");
});
after(() => {
  for (const k of [...ENV_KEYS, "CORTEX_DATA_DIR"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("sqlite : un seuil n'est signalé qu'une fois, même par un process neuf ou pendant une transaction annulée", async (t) => {
  const subjects: string[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    subjects.push((JSON.parse(String(init?.body)) as { subject: string }).subject);
    return new Response("{}", { status: 200 });
  });
  process.env.SPEND_CAP_USD = "10";
  process.env.RESEND_API_KEY = "re_test";
  process.env.CORTEX_OWNER_EMAIL = "ben@exemple.test";
  const { authTx } = await import("../db/auth-store");

  await usage.recordUsage({ provider: "anthropic", model: "claude-sonnet-5", tokensIn: 4_500_000 }); // 9 $
  // Une transaction voisine, sur la même connexion, qui finira annulée : le marqueur ne doit pas partir avec elle.
  const cancelled = authTx(async () => {
    await new Promise((r) => setTimeout(r, 30));
    throw new Error("annulée");
  }).catch(() => "annulée");
  await usage.assertSpendCap("anthropic");
  assert.equal(await cancelled, "annulée");
  assert.deepEqual(subjects, ["Cortex : 80 % du plafond de dépense IA du mois"]);

  usage.resetSpendCache();
  await usage.assertSpendCap("anthropic");
  assert.equal(subjects.length, 1);

  await usage.recordUsage({ provider: "anthropic", model: "claude-sonnet-5", tokensIn: 1_000_000 }); // 11 $
  usage.resetSpendCache();
  await assert.rejects(() => usage.assertSpendCap("anthropic"), (e: Error & { code?: string }) => e.code === "SPEND_CAP");
  usage.resetSpendCache();
  await assert.rejects(() => usage.assertSpendCap("anthropic"), (e: Error & { code?: string }) => e.code === "SPEND_CAP");
  assert.equal(subjects.length, 2);
});
