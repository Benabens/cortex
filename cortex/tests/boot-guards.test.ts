import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * I8 — Un déploiement où AUTH_ENABLED a été oublié sert TOUT le monde comme
 * « owner ». Le boot de prod doit refuser de démarrer dès que l'instance est
 * manifestement une mise en ligne (NODE_ENV=production) ou encaisse de
 * l'argent (BILLING_ENABLED=1) sans authentification.
 */

test("I8 — production sans AUTH_ENABLED=1 → refus de démarrer", async () => {
  const { assertAuthRequired } = await import("../lib/boot-guards");
  assert.throws(() => assertAuthRequired({ NODE_ENV: "production" }), /AUTH_ENABLED/);
  assert.throws(() => assertAuthRequired({ NODE_ENV: "production", AUTH_ENABLED: "0" }), /AUTH_ENABLED/);
});

test("I8 — facturation active sans auth → refus, même hors production", async () => {
  const { assertAuthRequired } = await import("../lib/boot-guards");
  assert.throws(() => assertAuthRequired({ BILLING_ENABLED: "1" }), /AUTH_ENABLED/);
});

test("I8 — configurations légitimes : dev sans rien, prod avec auth", async () => {
  const { assertAuthRequired } = await import("../lib/boot-guards");
  assert.doesNotThrow(() => assertAuthRequired({}));
  assert.doesNotThrow(() => assertAuthRequired({ NODE_ENV: "development" }));
  assert.doesNotThrow(() => assertAuthRequired({ NODE_ENV: "production", AUTH_ENABLED: "1" }));
  assert.doesNotThrow(() => assertAuthRequired({ BILLING_ENABLED: "1", AUTH_ENABLED: "1" }));
});

test("I8 — le script prod-boot appelle bien la garde", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../scripts/prod-boot.ts", import.meta.url), "utf8");
  assert.match(src, /assertAuthRequired\(/);
});

test("2b-9 — provider claude-code refusé sur une instance multi-utilisateurs, hébergée ou facturée, sauf CORTEX_OWNER_ONLY=1", async () => {
  const { assertLlmProviderAllowed } = await import("../lib/boot-guards");
  // claude-code est le provider PAR DÉFAUT quand LLM_PROVIDER est absent.
  assert.throws(() => assertLlmProviderAllowed({ AUTH_ENABLED: "1" }), /claude-code/);
  assert.throws(() => assertLlmProviderAllowed({ LLM_PROVIDER: "claude-code", BILLING_ENABLED: "1" }), /claude-code/);
  assert.throws(() => assertLlmProviderAllowed({ LLM_PROVIDER: "claude-code", RAILWAY_PROJECT_ID: "p" }), /claude-code/);
  assert.throws(() => assertLlmProviderAllowed({ LLM_PROVIDER: "claude-code", CORTEX_HOSTED: "1" }), /claude-code/);
  assert.doesNotThrow(() => assertLlmProviderAllowed({ LLM_PROVIDER: "claude-code", AUTH_ENABLED: "1", CORTEX_OWNER_ONLY: "1" }));
  assert.doesNotThrow(() => assertLlmProviderAllowed({ LLM_PROVIDER: "anthropic", AUTH_ENABLED: "1", BILLING_ENABLED: "1" }));
  assert.doesNotThrow(() => assertLlmProviderAllowed({}), "dev mono-poste : rien de gardé");
});

test("2b-9 — prod-boot et instrumentation appellent la garde du provider", async () => {
  const fs = await import("node:fs");
  assert.match(fs.readFileSync("scripts/prod-boot.ts", "utf8"), /assertLlmProviderAllowed\(/);
  assert.match(fs.readFileSync("instrumentation.ts", "utf8"), /assertLlmProviderAllowed\(/);
});

test("revue — garde serveur : NODE_ENV=production AVEC une vraie base Postgres (VPS, next start direct) sans auth → refus ; sqlite/PGlite local → démarre", async () => {
  const { assertAuthRequiredHosted } = await import("../lib/boot-guards");
  assert.throws(() => assertAuthRequiredHosted({ NODE_ENV: "production", DB_DRIVER: "postgres", DATABASE_URL: "postgres://u@db/cortex" }), /AUTH_ENABLED/);
  assert.doesNotThrow(() => assertAuthRequiredHosted({ NODE_ENV: "production", DB_DRIVER: "postgres", DATABASE_URL: "pglite://memory" }));
  assert.doesNotThrow(() => assertAuthRequiredHosted({ NODE_ENV: "production" }), "smoke test CI : sqlite");
  assert.doesNotThrow(() => assertAuthRequiredHosted({ NODE_ENV: "production", DB_DRIVER: "postgres", DATABASE_URL: "postgres://u@db/cortex", AUTH_ENABLED: "1" }));
});
