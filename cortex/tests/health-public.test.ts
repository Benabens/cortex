import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * /api/health est public (sonde UptimeRobot, healthcheck Railway, smoke CI) :
 * il ne doit dire que « ok / degraded » et le commit servi (public, comme le dépôt). Le détail de l'infrastructure (pilote,
 * nombre de cours, moteur, sandbox, LaTeX) n'est servi qu'avec METRICS_TOKEN.
 */

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.METRICS_TOKEN = "jeton-sante-0123456789";

const url = "http://cortex.test/api/health";

test("sans jeton : { status, commit } seuls, 200", async () => {
  const { GET } = await import("../app/api/health/route");
  const res = await GET(new Request(url));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok", commit: null });
});

test("faux jeton ou jeton en query string : réponse publique", async () => {
  const { GET } = await import("../app/api/health/route");
  for (const req of [
    new Request(url, { headers: { authorization: "Bearer jeton-sante-9876543210" } }),
    new Request(`${url}?token=jeton-sante-0123456789`),
  ]) {
    assert.deepEqual(Object.keys(await (await GET(req)).json()), ["status", "commit"]);
  }
});

test("avec METRICS_TOKEN en Bearer : détail complet", async () => {
  const { GET } = await import("../app/api/health/route");
  const res = await GET(new Request(url, { headers: { authorization: "Bearer jeton-sante-0123456789" } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.checks.db, true);
  for (const key of ["driver", "checks", "verification", "uptimeSec"]) assert.ok(key in body, key);
});
