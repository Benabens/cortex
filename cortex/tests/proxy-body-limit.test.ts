/**
 * Le proxy Next tronque tout corps au-delà de `proxyClientMaxBodySize` : une
 * route dont le plafond dépasse cette borne reçoit un multipart coupé et répond
 * un 400 obscur (prod, 13/11/2026 : annales de plus de 10 Mo). Invariant : la
 * borne du proxy dépasse CHAQUE plafond de route, y compris relevé par UPLOAD_MAX_MB.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.UPLOAD_MAX_MB = "200"; // lu au chargement de lib/body-size-limits

const MiB = 1024 * 1024;

test("la borne du proxy de next.config dépasse chaque plafond de route", async () => {
  const { UPLOAD_LIMITS } = await import("../lib/body-size-limits");
  const { default: config } = await import("../next.config");
  const proxy = config.experimental?.proxyClientMaxBodySize;
  assert.equal(typeof proxy, "number", "borne calculée, pas une chaîne recopiée à la main");
  for (const [route, max] of Object.entries(UPLOAD_LIMITS)) {
    assert.ok((proxy as number) > max, `${route} : plafond ${max / MiB} Mio ≥ borne du proxy ${(proxy as number) / MiB} Mio`);
  }
});

test("UPLOAD_MAX_MB relève aussi la borne du proxy", async () => {
  const { UPLOAD_LIMITS, proxyBodyLimitBytes } = await import("../lib/body-size-limits");
  assert.equal(UPLOAD_LIMITS.refs, 200 * MiB);
  assert.ok(proxyBodyLimitBytes() > 200 * MiB);
});

test("sans UPLOAD_MAX_MB, la borne couvre les annales par défaut (64 Mio)", async () => {
  const { proxyBodyLimitBytes } = await import("../lib/body-size-limits");
  assert.ok(proxyBodyLimitBytes({ refs: 64 * MiB, source: 32 * MiB, image: 16 * MiB }) > 64 * MiB);
});
