/**
 * LOT 4-4 / I13 — la démo publique (PUBLIC_DEMO=1) n'ouvre les pages de lecture
 * SANS session qu'aux visiteurs anonymes : un compte connecté doit voir SES
 * données (x-cortex-user posé), jamais celles du tenant « owner ».
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { demoReadable } from "../lib/demo-paths";

test("demoReadable : GET des pages de démo, seulement avec PUBLIC_DEMO=1", () => {
  assert.equal(demoReadable("/", "GET", { PUBLIC_DEMO: "1" }), true);
  assert.equal(demoReadable("/revision", "GET", { PUBLIC_DEMO: "1" }), true);
  assert.equal(demoReadable("/revision", "POST", { PUBLIC_DEMO: "1" }), false);
  assert.equal(demoReadable("/compte", "GET", { PUBLIC_DEMO: "1" }), false);
  assert.equal(demoReadable("/", "GET", {}), false);
});

test("proxy : la session est évaluée AVANT le contournement démo, qui ne s'applique qu'à un anonyme", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  const guarded = src.slice(src.indexOf("async function guarded"));
  const demo = guarded.indexOf("demoReadable(");
  const session = guarded.indexOf("await auth()");
  assert.ok(demo > 0 && session > 0);
  assert.ok(session < demo, "auth() doit précéder la décision de démo");
  assert.match(guarded, /demoReadable\([^)]*\)\s*&&\s*!userId/, "le contournement exige l'absence de session");
});
