/**
 * APERÇU D'UN FICHIER RESTÉ SUR L'ORDINATEUR (compte gratuit, décision du 17/11/2026) : les liens
 * « Voir » (/csrc, /refs) d'un fichier dont Cortex n'a gardé que l'index mènent à la page qui
 * l'ouvre depuis l'ordinateur, jamais à un 404 ; un fichier inconnu reste un 404 ; un fichier
 * présent est servi comme avant (Premium). Seams : routes GET /csrc, /refs/[file],
 * /api/sources/originals. Postgres réel (PGlite), aucun réseau.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-apercu-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.AUTH_ENABLED = "1";
const env = process.env as Record<string, string | undefined>;

before(async () => {
  delete env.CORTEX_USER;
  const { ensureCoursesLoaded, reloadCourses, coursePaths } = await import("../lib/courses");
  const { insertCourse } = await import("../db/courses-store");
  await ensureCoursesLoaded();
  await insertCourse({
    id: "moncours", owner_user_id: "alice", name: "Mon cours", short: "MC", code: null, exam_name: "Mon cours",
    exam_kind: "Final", university: null, university_lines: "[]", faculty: null, teachers: "[]", language: "fr",
    profile_id: null, duration_min: 120, exam_date: null, db_file: null, refs_rel: null, exams_rel: null,
    uploads_rel: null, content_rel: null, created_at: "2026-09-01 00:00:00",
  });
  await reloadCourses();
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const mine = runWithUser("alice", () => coursePaths("moncours"));
  fs.mkdirSync(mine.refsDir, { recursive: true });
  fs.writeFileSync(path.join(mine.refsDir, "garde.pdf"), "DANS LE CLOUD");
  const { recordLocal } = await import("../lib/originals/registry");
  await runWithUser("alice", () => runWithCourse("moncours", async () => {
    await recordLocal({ path: "refs/final-2024.pdf", name: "Final 2024.pdf", sha256: "a".repeat(64), size: 1234, origin: "upload" });
    await recordLocal({ path: "lectures/semaine-1/cours.pdf", name: "Cours 1.pdf", rel: "ML/Semaine 1/Cours 1.pdf", sha256: "b".repeat(64), size: 99, origin: "upload" });
  }));
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["CORTEX_DATA_DIR", "DB_DRIVER", "DATABASE_URL", "AUTH_ENABLED"]) delete env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const req = (url: string) => new NextRequest(`http://cortex.test${url}`, { headers: { "x-cortex-user": "alice", "x-cortex-course": "moncours" } });

test("/csrc : un cours resté sur l'ordinateur mène à la page qui l'ouvre en local", async () => {
  const { GET } = await import("../app/csrc/route");
  const r = await GET(req("/csrc?p=lectures/semaine-1/cours.pdf"));
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/sources/locale?course=moncours&p=lectures%2Fsemaine-1%2Fcours.pdf");
  const stale = await GET(req("/csrc?p=slides/cours.pdf"));
  assert.equal(stale.headers.get("location"), "/sources/locale?course=moncours&p=lectures%2Fsemaine-1%2Fcours.pdf", "ancien préfixe : retrouvé par son nom");
  assert.equal((await GET(req("/csrc?p=lectures/inconnu.pdf"))).status, 404);
});

test("/refs : annale restée sur l'ordinateur → page locale ; annale dans le cloud → servie comme avant", async () => {
  const { GET } = await import("../app/refs/[file]/route");
  const local = await GET(req("/refs/final-2024.pdf"), { params: Promise.resolve({ file: "final-2024.pdf" }) });
  assert.equal(local.status, 302);
  assert.equal(local.headers.get("location"), "/sources/locale?course=moncours&p=refs%2Ffinal-2024.pdf");
  const cloud = await GET(req("/refs/garde.pdf"), { params: Promise.resolve({ file: "garde.pdf" }) });
  assert.equal(cloud.status, 200);
  assert.equal(await cloud.text(), "DANS LE CLOUD");
});

test("/api/sources/originals : de quoi retrouver le fichier sur l'ordinateur", async () => {
  const { GET } = await import("../app/api/sources/originals/route");
  const r = await GET(req("/api/sources/originals?p=lectures/semaine-1/cours.pdf"));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(
    { name: body.original.name, rel: body.original.rel, size: body.original.size, sha256: body.original.sha256 },
    { name: "Cours 1.pdf", rel: "ML/Semaine 1/Cours 1.pdf", size: 99, sha256: "b".repeat(64) },
  );
  assert.equal((await GET(req("/api/sources/originals?p=refs/garde.pdf"))).status, 404);
});
