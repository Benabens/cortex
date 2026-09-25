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
