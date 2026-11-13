/**
 * SMOKE APRÈS DÉPLOIEMENT — le workflow post-deploy attend que la prod serve le
 * commit qu'il vient de déployer avant de la tester (puis de la rétablir si le
 * test échoue). /api/health dit donc quel commit tourne, et dans quel
 * environnement Railway — rien d'autre de nouveau, et rien de secret.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-health-"));
process.env.CORTEX_DATA_DIR = tmp;
const env = process.env as Record<string, string | undefined>;
env.METRICS_TOKEN = "jeton-release-0123456789";
const pub = () => new Request("http://cortex.test/api/health");
const withToken = () => new Request("http://cortex.test/api/health", { headers: { authorization: "Bearer jeton-release-0123456789" } });

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "RAILWAY_GIT_COMMIT_SHA", "RAILWAY_ENVIRONMENT_NAME", "METRICS_TOKEN"]) delete env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("/api/health expose le commit déployé et l'environnement Railway", async () => {
  env.RAILWAY_GIT_COMMIT_SHA = "87b646924b23386a100ebc1005a8d81b29115315";
  env.RAILWAY_ENVIRONMENT_NAME = "production";
  const { GET } = await import("../app/api/health/route");
  // Public : le commit suffit au workflow post-deploy, rien d'autre ne sort.
  const pubBody = await (await GET(pub())).json();
  assert.deepEqual(pubBody, { status: "ok", commit: "87b646924b23386a100ebc1005a8d81b29115315" });
  // Avec METRICS_TOKEN : commit et environnement Railway.
  const body = await (await GET(withToken())).json();
  assert.equal(body.commit, "87b646924b23386a100ebc1005a8d81b29115315");
  assert.equal(body.environment, "production");
});

test("/api/health hors Railway (poste de dev, CI) : commit et environnement inconnus, la sonde reste saine", async () => {
  delete env.RAILWAY_GIT_COMMIT_SHA;
  delete env.RAILWAY_ENVIRONMENT_NAME;
  const { GET } = await import("../app/api/health/route");
  const r = await GET(withToken());
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.commit, null);
  assert.equal(body.environment, null);
});
