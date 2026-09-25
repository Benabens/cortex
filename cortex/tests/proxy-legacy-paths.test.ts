import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";

/**
 * Mineur — /voir lit des .html hors de l'app et /sites était public (liens
 * vers des fiches perso). En production, ces deux chemins n'existent plus
 * (404) ; en développement, /sites n'est plus exempté d'authentification.
 */

(process.env as Record<string, string | undefined>).NODE_ENV = "production";

test("production : /voir et /sites/* répondent 404 dès le proxy", async () => {
  const { default: proxy } = await import("../proxy");
  for (const p of ["/voir?src=x.html", "/sites/index.html", "/sites/cours/x.html"]) {
    const res = await proxy(new NextRequest(`http://cortex.test${p}`));
    assert.equal(res.status, 404, `${p} → ${res.status}`);
  }
});

test("production : le reste passe (pas d'effet de bord sur les autres chemins)", async () => {
  const { default: proxy } = await import("../proxy");
  const res = await proxy(new NextRequest("http://cortex.test/api/health"));
  assert.equal(res.status, 200);
});

test("/sites n'est plus dans les préfixes publics du proxy", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  const m = src.match(/const PUBLIC_PREFIXES = \[([^\]]*)\]/);
  assert.ok(m, "PUBLIC_PREFIXES introuvable");
  assert.ok(!m![1].includes('"/sites"'), "/sites est encore public");
});
