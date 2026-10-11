/**
 * IMAGE DE BASE DE L'IMAGE DE PRODUCTION. Le 9 octobre 2026, Docker Hub a
 * refusé les pulls pendant une heure et deux builds de production ont échoué
 * sur `FROM node:22-slim`. La base vient depuis d'un miroir des images
 * officielles, épinglée par son condensé : c'est bit pour bit l'image
 * officielle, et un tag déplacé sur le miroir ne change pas ce qui est
 * construit. Ces gardes empêchent d'y revenir par mégarde.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

test("Dockerfile : une seule image de base pour les trois étapes, hors de Docker Hub et épinglée par son condensé", () => {
  const docker = fs.readFileSync("../Dockerfile", "utf8");
  const froms = docker.match(/^FROM .+$/gm) ?? [];
  assert.equal(froms.length, 3, froms.join("\n"));
  for (const from of froms) assert.match(from, /^FROM \$\{NODE_IMAGE\} AS \w+$/, "chaque étape part de la même base");
  const base = docker.match(/^ARG NODE_IMAGE=(\S+)$/m)?.[1] ?? "";
  assert.match(base, /^public\.ecr\.aws\/docker\/library\/node:22-slim@sha256:[0-9a-f]{64}$/, `base déclarée : « ${base} »`);
});

test("CI : l'image est construite avec la base du Dockerfile, celle que l'hébergeur construira", () => {
  const ci = fs.readFileSync("../.github/workflows/ci.yml", "utf8");
  assert.doesNotMatch(ci, /NODE_IMAGE/, "aucune base de rechange passée au build de la CI");
  assert.doesNotMatch(ci, /pull-official\.sh node/, "aucune image renommée sur laquelle le Dockerfile ne s'appuie plus");
});
