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

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "RAILWAY_GIT_COMMIT_SHA", "RAILWAY_ENVIRONMENT_NAME"]) delete env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("/api/health expose le commit déployé et l'environnement Railway", async () => {
  env.RAILWAY_GIT_COMMIT_SHA = "87b646924b23386a100ebc1005a8d81b29115315";
  env.RAILWAY_ENVIRONMENT_NAME = "production";
  const { GET } = await import("../app/api/health/route");
  const body = await (await GET()).json();
  assert.equal(body.status, "ok");
  assert.equal(body.commit, "87b646924b23386a100ebc1005a8d81b29115315");
  assert.equal(body.environment, "production");
});

test("/api/health hors Railway (poste de dev, CI) : commit et environnement inconnus, la sonde reste saine", async () => {
  delete env.RAILWAY_GIT_COMMIT_SHA;
  delete env.RAILWAY_ENVIRONMENT_NAME;
  const { GET } = await import("../app/api/health/route");
  const r = await GET();
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.commit, null);
  assert.equal(body.environment, null);
});
