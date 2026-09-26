/**
 * Lot 1b/2 — la garde « pas de production sans authentification » ne dépend
 * plus du seul prod-boot (entrypoint Docker) : le serveur Next lui-même refuse
 * de démarrer (instrumentation.register) — un `next start` direct sans
 * AUTH_ENABLED=1 ne sert personne. Le mode dev et les tests restent intacts.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bootguard-"));
process.env.CORTEX_DATA_DIR = tmp;
const env = process.env as Record<string, string | undefined>;

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "NEXT_RUNTIME", "NODE_ENV", "AUTH_ENABLED", "BILLING_ENABLED"]) delete env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("production sans AUTH_ENABLED : register() refuse", async () => {
  env.NEXT_RUNTIME = "nodejs";
  env.NODE_ENV = "production";
  delete env.AUTH_ENABLED;
  const { register } = await import("../instrumentation");
  await assert.rejects(() => register(), /AUTH_ENABLED/);
});

test("développement : register() démarre (aucune garde ne se déclenche)", async () => {
  env.NEXT_RUNTIME = "nodejs";
  env.NODE_ENV = "development";
  delete env.AUTH_ENABLED;
  delete env.BILLING_ENABLED;
  const { register } = await import("../instrumentation");
  await register();
  const g = globalThis as { __cortexJobsPump?: ReturnType<typeof setInterval> };
  if (g.__cortexJobsPump) clearInterval(g.__cortexJobsPump);
});
