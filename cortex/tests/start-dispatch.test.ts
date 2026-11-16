/**
 * DÉMARRAGE DU CONTENEUR — scripts/start.sh (CMD du Dockerfile) aiguille les
 * previews de PR Railway vers preview-entrypoint.sh et tout le reste vers
 * docker-entrypoint.sh. railway.json le faisait jusqu'ici ; Railway cesse de le
 * lire le 2026-12-01, et sans cet aiguillage une preview démarrerait avec les
 * secrets copiés de la prod. La reconnaissance d'une PR doit être celle de la
 * garde de démarrage (lib/railway-env), au caractère près.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { isPrEnvironment } from "../lib/railway-env";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-start-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Le vrai start.sh, à côté de deux faux entrypoints qui annoncent lequel a été lancé. */
function started(env: Record<string, string>): { status: number | null; out: string } {
  fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "..", "scripts", "start.sh"), path.join(tmp, "scripts/start.sh"));
  fs.writeFileSync(path.join(tmp, "scripts/preview-entrypoint.sh"), 'echo "PREVIEW $*"\n');
  fs.writeFileSync(path.join(tmp, "scripts/docker-entrypoint.sh"), 'echo "DOCKER $*"\n');
  const r = spawnSync("bash", [path.join(tmp, "scripts/start.sh"), "arg"], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim() };
}

test("preview de PR → preview-entrypoint.sh ; production, autre environnement ou hors Railway → docker-entrypoint.sh", () => {
  const names = ["cortex-pr-66", "pr-1", "Cortex-PR-12", " cortex-pr-7 ", "production", "staging", "cortex-pr-", "pr-66-old", "cortex-pr-66x", ""];
  for (const name of names) {
    const expected = isPrEnvironment(name.trim()) ? "PREVIEW arg" : "DOCKER arg";
    const r = started({ RAILWAY_ENVIRONMENT_NAME: name });
    assert.equal(r.status, 0, name);
    assert.equal(r.out, expected, `« ${name} »`);
  }
  assert.equal(started({}).out, "DOCKER arg", "docker run local, CI : aucune variable Railway");
});

test("le nom vient de RAILWAY_ENVIRONMENT_NAME, sinon de RAILWAY_ENVIRONMENT (comme railwayEnvironmentName)", () => {
  assert.equal(started({ RAILWAY_ENVIRONMENT: "cortex-pr-66" }).out, "PREVIEW arg");
  assert.equal(started({ RAILWAY_ENVIRONMENT_NAME: "production", RAILWAY_ENVIRONMENT: "cortex-pr-66" }).out, "DOCKER arg");
  assert.equal(started({ RAILWAY_ENVIRONMENT_NAME: "", RAILWAY_ENVIRONMENT: "cortex-pr-66" }).out, "PREVIEW arg");
});

test("le Dockerfile démarre par start.sh, et preview-entrypoint.sh enchaîne sur docker-entrypoint.sh (pas de boucle)", () => {
  const docker = fs.readFileSync(path.join(__dirname, "..", "..", "Dockerfile"), "utf8");
  const cmds = [...docker.matchAll(/^\s*CMD\s+(.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(cmds.slice(-1), ['["bash", "scripts/start.sh"]']);
  const preview = fs.readFileSync(path.join(__dirname, "..", "scripts", "preview-entrypoint.sh"), "utf8");
  assert.match(preview, /^exec bash scripts\/docker-entrypoint\.sh$/m);
  assert.doesNotMatch(preview, /^\s*exec\b.*start\.sh/m, "preview-entrypoint.sh ne relance pas start.sh");
});
