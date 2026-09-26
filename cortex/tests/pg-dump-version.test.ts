/**
 * LOT 5b — « pg_dump: error: aborting because of server version mismatch » :
 * le serveur Railway est en 18, l'image embarquait postgresql-client-17. La
 * version majeure du client doit être ≥ celle du serveur ; on l'avertit AU
 * DÉMARRAGE (pas à 3 h du matin), et l'image par défaut embarque la 18.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL"]) delete process.env[k];
});

test("comparaison des versions majeures : client < serveur → avertissement explicite, sinon rien", async () => {
  const { parsePgMajor, pgDumpMismatch } = await import("../lib/pg-dump-version");
  assert.equal(parsePgMajor("pg_dump (PostgreSQL) 18.6 (Homebrew)"), 18);
  assert.equal(parsePgMajor("pg_dump (PostgreSQL) 17.6 (Debian 17.6-1.pgdg12+1)"), 17);
  assert.equal(parsePgMajor(undefined), null);
  assert.equal(pgDumpMismatch({ serverVersionNum: 180001, pgDumpVersion: "pg_dump (PostgreSQL) 17.6" })?.serverMajor, 18);
  assert.match(pgDumpMismatch({ serverVersionNum: 180001, pgDumpVersion: "pg_dump (PostgreSQL) 17.6" })!.message, /pg_dump 17 .*serveur 18|version mismatch|PG_CLIENT_MAJOR/i);
  assert.equal(pgDumpMismatch({ serverVersionNum: 180001, pgDumpVersion: "pg_dump (PostgreSQL) 18.6" }), null);
  assert.equal(pgDumpMismatch({ serverVersionNum: 170004, pgDumpVersion: "pg_dump (PostgreSQL) 18.6" }), null, "client plus récent : autorisé");
  assert.match(pgDumpMismatch({ serverVersionNum: 180001, pgDumpVersion: undefined })!.message, /introuvable|absent/i);
});

test("lecture de la version du serveur (current_setting) et avertissement au démarrage", async () => {
  const { serverVersionNum, warnIfPgDumpTooOld } = await import("../lib/pg-dump-version");
  const v = await serverVersionNum();
  assert.ok(v !== null && v >= 150000, `version serveur lue : ${v}`);
  const logs: string[] = [];
  const r = await warnIfPgDumpTooOld({ log: (m) => logs.push(m), pgDumpVersion: "pg_dump (PostgreSQL) 12.0", expectDump: true });
  assert.ok(r, "un client 12 face à ce serveur doit être signalé");
  assert.ok(logs.some((l) => /pg_dump/.test(l) && /serveur/.test(l)), logs.join("\n"));
  assert.equal(await warnIfPgDumpTooOld({ log: () => {}, pgDumpVersion: "pg_dump (PostgreSQL) 99.0", expectDump: true }), null);
  assert.equal(await warnIfPgDumpTooOld({ log: () => {}, pgDumpVersion: "pg_dump (PostgreSQL) 12.0", expectDump: false }), null, "sqlite / PGlite : pas de dump réseau, pas d'avertissement");
  const src = fs.readFileSync("instrumentation.ts", "utf8");
  assert.match(src, /warnIfPgDumpTooOld\(/, "vérifié au démarrage du serveur");
});

test("image et CI : client PostgreSQL 18 par défaut, configurable par ARG", () => {
  const docker = fs.readFileSync("../Dockerfile", "utf8");
  assert.match(docker, /ARG PG_CLIENT_MAJOR=18/);
  assert.match(docker, /postgresql-client-\$\{PG_CLIENT_MAJOR\}/);
  const ci = fs.readFileSync("../.github/workflows/ci.yml", "utf8");
  assert.match(ci, /image: postgres:18/);
  assert.match(ci, /pg_dump --version \| grep -E ['"]? ?18\\?\./, "la CI vérifie la version 18 de pg_dump dans l'image");
  const deploy = fs.readFileSync("../DEPLOY.md", "utf8");
  assert.match(deploy, /PG_CLIENT_MAJOR/);
});
