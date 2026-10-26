/**
 * IMAGE DE BASE DE L'IMAGE DE PRODUCTION. Le 9 octobre 2026, Docker Hub a
 * refusé les pulls pendant une heure et deux builds de production ont échoué
 * sur `FROM node:22-slim`. La base vient depuis d'un miroir des images
 * officielles, épinglée par son condensé : c'est bit pour bit l'image
 * officielle, et un tag déplacé sur le miroir ne change pas ce qui est
 * construit. Ces gardes empêchent d'y revenir par mégarde, par un `FROM` comme
 * par un détour (`COPY --from=<image>`, `# syntax=`, ARG redéfini).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

/** Ce que le Dockerfile tire d'un registre, hors de sa base : une liste vide est attendue. */
function strayImages(docker: string): string[] {
  const stages = new Set<string>();
  const stray: string[] = [];
  for (const line of docker.split("\n")) {
    const from = line.match(/^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
    if (from) {
      // Une étape part de la base, ou d'une étape déjà construite.
      if (from[1] !== "${NODE_IMAGE}" && !stages.has(from[1])) stray.push(line.trim());
      if (from[2]) stages.add(from[2]);
    }
    // COPY --from=… et RUN --mount=…,from=… : seulement depuis une étape.
    for (const [, source] of line.matchAll(/\bfrom=([^\s,]+)/gi)) if (!stages.has(source)) stray.push(line.trim());
    // Le frontend BuildKit se télécharge lui aussi, de Docker Hub par défaut.
    if (/^#\s*syntax\s*=/i.test(line)) stray.push(line.trim());
  }
  return stray;
}

test("Dockerfile : toutes les étapes partent d'une seule base, hors de Docker Hub et épinglée par son condensé", () => {
  const docker = fs.readFileSync("../Dockerfile", "utf8");
  assert.deepEqual(strayImages(docker), [], "rien d'autre n'est tiré d'un registre");
  assert.ok(/^\s*FROM\s+\$\{NODE_IMAGE\}/im.test(docker), "au moins une étape part de la base");
  const bases = [...docker.matchAll(/^\s*ARG\s+NODE_IMAGE(?:=(\S*))?\s*$/gim)].map((m) => m[1] ?? "");
  assert.equal(bases.length, 1, "une seule définition : Docker retiendrait la dernière");
  assert.match(bases[0], /^public\.ecr\.aws\/docker\/library\/node:22-slim@sha256:[0-9a-f]{64}$/, `base déclarée : « ${bases[0]} »`);
});

test("la garde voit les détours : image dans un COPY --from, un montage, un frontend, un FROM en minuscules", () => {
  const base = "ARG NODE_IMAGE=x\nFROM ${NODE_IMAGE} AS deps\nFROM deps AS tests\nCOPY --from=deps /a /b\n";
  assert.deepEqual(strayImages(base), [], "étape bâtie sur une autre étape, copie entre étapes : rien à redire");
  for (const detour of ["COPY --from=node:22-slim /usr/local/bin/node /n", "RUN --mount=type=bind,from=node:22-slim,target=/m true", "# syntax=docker/dockerfile:1", "from node:22-slim as outils", "  FROM debian:12"]) {
    assert.equal(strayImages(`${base}${detour}\n`).length, 1, detour);
  }
});

test("CI : l'image est construite avec la base du Dockerfile (même condensé), celle que l'hébergeur construira", () => {
  const ci = fs.readFileSync("../.github/workflows/ci.yml", "utf8");
  // Un second miroir est permis quand le premier limite, mais seulement avec le condensé lu dans le Dockerfile.
  assert.doesNotMatch(ci, /sha256:[0-9a-f]{64}/, "aucun condensé recopié dans la CI");
  for (const m of ci.matchAll(/NODE_IMAGE=([^\s"]+)/g)) assert.equal(m[1], "$IMAGE", `base passée au build : ${m[1]}`);
  assert.match(ci, /\*"@\$DIGEST"\)/, "le build vérifie que l'image porte le condensé du Dockerfile");
  assert.doesNotMatch(ci, /pull-official\.sh node/, "aucune image renommée sur laquelle le Dockerfile ne s'appuie plus");
});
