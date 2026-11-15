/**
 * AUDIT DU 14/11/2026, n° 17 — conteneur sans root. L'image tourne en `cortex` ; sur Railway le
 * volume est monté en root (RAILWAY_RUN_UID=0 : l'entrypoint en fait le chown puis abandonne
 * root). Ici, hors Docker : un volume non inscriptible fait refuser le démarrage avec la consigne,
 * un volume inscriptible laisse démarrer. Le chemin root (chown + setpriv) est vérifié par la CI
 * sur l'image réelle (job docker).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-entrypoint-"));
after(() => {
  for (const d of fs.readdirSync(tmp)) fs.chmodSync(path.join(tmp, d), 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** L'entrypoint réel, à côté d'un faux `next` qui annonce son démarrage (pas de prod-boot). */
function run(env: Record<string, string>) {
  const app = fs.mkdtempSync(path.join(tmp, "app-"));
  fs.mkdirSync(path.join(app, "scripts"));
  fs.mkdirSync(path.join(app, "node_modules/.bin"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "..", "scripts", "docker-entrypoint.sh"), path.join(app, "scripts/docker-entrypoint.sh"));
  fs.writeFileSync(path.join(app, "node_modules/.bin/next"), "#!/usr/bin/env bash\necho NEXT_STARTED\n", { mode: 0o755 });
  return spawnSync("bash", [path.join(app, "scripts/docker-entrypoint.sh")], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
}

test("volume non inscriptible (monté en root, sans RAILWAY_RUN_UID=0) : refus de démarrer, avec la consigne", { skip: process.getuid?.() === 0 }, () => {
  const vol = fs.mkdtempSync(path.join(tmp, "vol-"));
  fs.chmodSync(vol, 0o555);
  const r = run({ CORTEX_DATA_DIR: vol });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /RAILWAY_RUN_UID=0/);
  assert.ok(!r.stdout.includes("NEXT_STARTED"), "next ne démarre pas");
});

test("volume inscriptible : démarrage normal, aucune trace de la sonde d'écriture", { skip: process.getuid?.() === 0 }, () => {
  const vol = fs.mkdtempSync(path.join(tmp, "vol-"));
  const r = run({ CORTEX_DATA_DIR: vol });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NEXT_STARTED/);
  assert.deepEqual(fs.readdirSync(vol), []);
});
