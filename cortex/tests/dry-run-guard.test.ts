/**
 * PRÉ-LANCEMENT 1 — la génération « dry-run » (stub local, sans appel au modèle)
 * court-circuitait la réservation de crédits, le quota et les places : elle
 * écrivait des lignes d'examen et lançait tectonic gratuitement, autant de fois
 * que voulu. Elle n'existe plus que hors déploiement gardé (poste de dev) ou,
 * sur une instance gardée, pour le compte propriétaire avec CORTEX_OWNER_ONLY=1.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dry-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
const env = process.env as Record<string, string | undefined>;

before(async () => {
  delete env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["CORTEX_DATA_DIR", "DB_DRIVER", "DATABASE_URL", "AUTH_ENABLED", "BILLING_ENABLED", "CORTEX_OWNER_ONLY", "CORTEX_OWNER_USER_ID", "CORTEX_OWNER_EMAIL"]) delete env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("dryRunAllowed : jamais en déploiement gardé, sauf propriétaire explicitement autorisé", async () => {
  const { dryRunAllowed } = await import("../lib/boot-guards");
  // Poste de dev : rien de gardé → l'outil de développement reste disponible.
  assert.equal(await dryRunAllowed({}, "owner"), true);
  // Déploiement gardé : refusé, pour tout le monde.
  for (const guard of [{ AUTH_ENABLED: "1" }, { BILLING_ENABLED: "1" }, { RAILWAY_PROJECT_ID: "p" }, { CORTEX_HOSTED: "1" }]) {
    assert.equal(await dryRunAllowed(guard, "owner"), false, JSON.stringify(guard));
    assert.equal(await dryRunAllowed(guard, "alice"), false, JSON.stringify(guard));
  }
  // Instance mono-utilisateur assumée : le propriétaire y garde l'outil, personne d'autre.
  const owner = { AUTH_ENABLED: "1", CORTEX_OWNER_ONLY: "1" };
  assert.equal(await dryRunAllowed(owner, "owner"), true);
  assert.equal(await dryRunAllowed(owner, "alice"), false);
  assert.equal(await dryRunAllowed({ ...owner, CORTEX_OWNER_USER_ID: "u-42" }, "u-42"), true);
  assert.equal(await dryRunAllowed({ ...owner, CORTEX_OWNER_USER_ID: "u-42" }, "owner"), false);
});

test("dryRunAllowed reconnaît le propriétaire désigné par e-mail, comme partout ailleurs", async () => {
  const { dryRunAllowed } = await import("../lib/boot-guards");
  const { authRun } = await import("../db/auth-store");
  // Le reste du code identifie le propriétaire par CORTEX_OWNER_EMAIL
  // (lib/account-deletion). Le garde du dry-run ne lisait que l'identifiant :
  // sur une instance configurée par e-mail, il refusait l'outil à Ben lui-même.
  await authRun(`INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT (id) DO NOTHING`, "u-ben", "ben@exemple.test");
  await authRun(`INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT (id) DO NOTHING`, "u-autre", "autre@exemple.test");
  const owner = { AUTH_ENABLED: "1", CORTEX_OWNER_ONLY: "1", CORTEX_OWNER_EMAIL: "Ben@Exemple.test" };
  assert.equal(await dryRunAllowed(owner, "u-ben"), true, "l'e-mail désigne bien le propriétaire (casse ignorée)");
  assert.equal(await dryRunAllowed(owner, "u-autre"), false);
});

test("POST /api/exams/generate?dry=1 en déploiement gardé : 404, aucune ligne d'examen, aucun fichier écrit", async () => {
  env.AUTH_ENABLED = "1";
  env.BILLING_ENABLED = "1";
  const { POST } = await import("../app/api/exams/generate/route");
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const count = () => runWithUser("owner", () => runWithCourse("cs-202", async () =>
    Number((await q.get<{ n: number }>(`SELECT count(*) n FROM exams`))?.n ?? 0)));
  const before_ = await count();
  const req = new NextRequest("http://cortex.test/api/exams/generate?course=cs-202&dry=1", {
    method: "POST", headers: { "content-type": "application/json", "x-cortex-user": "owner" }, body: "{}",
  });
  const r = await POST(req);
  assert.equal(r.status, 404, await r.clone().text());
  assert.equal(await count(), before_, "aucune ligne d'examen créée");
  const examsDir = path.join(tmp, "exams");
  const written = fs.existsSync(examsDir) ? fs.readdirSync(examsDir).filter((f) => f.endsWith(".tex")) : [];
  assert.deepEqual(written, [], "aucun .tex écrit, donc aucune compilation lancée");
});
