import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";

/**
 * Mineur — /api/metrics acceptait le jeton en query string (il finit dans les
 * logs, l'historique, le Referer) et le comparait avec ===. Jeton uniquement
 * via Authorization: Bearer, comparaison en temps constant.
 */

process.env.METRICS_TOKEN = "secret-de-test-0123456789";

test("jeton en ?token= → refusé", async () => {
  const { GET } = await import("../app/api/metrics/route");
  const res = await GET(new NextRequest("http://cortex.test/api/metrics?token=secret-de-test-0123456789"));
  assert.equal(res.status, 401);
});

test("jeton en Authorization: Bearer → accepté ; faux jeton (même longueur ou non) → 401 sans exception", async () => {
  const { GET } = await import("../app/api/metrics/route");
  const ok = await GET(new NextRequest("http://cortex.test/api/metrics", { headers: { authorization: "Bearer secret-de-test-0123456789" } }));
  assert.equal(ok.status, 200);
  const sameLen = await GET(new NextRequest("http://cortex.test/api/metrics", { headers: { authorization: "Bearer secret-de-test-9876543210" } }));
  assert.equal(sameLen.status, 401);
  const shorter = await GET(new NextRequest("http://cortex.test/api/metrics", { headers: { authorization: "Bearer x" } }));
  assert.equal(shorter.status, 401);
  const none = await GET(new NextRequest("http://cortex.test/api/metrics"));
  assert.equal(none.status, 401);
});

test("la comparaison passe par timingSafeEqual", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../lib/metrics-token.ts", import.meta.url), "utf8");
  assert.match(src, /timingSafeEqual/);
  for (const file of ["../app/api/metrics/route.ts", "../app/api/health/route.ts", "../lib/metrics-token.ts"]) {
    const route = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(!/searchParams\.get\("token"\)/.test(route), `${file} : le jeton est encore lu en query string`);
  }
});
