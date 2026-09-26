/**
 * LOT 4-3 / B10 — export des données du compte : GET /api/account/export
 * (self-only, auth obligatoire) renvoie une archive tar.gz EN FLUX avec le
 * profil, les cours possédés, le contenu des schémas tenant (JSON par table),
 * l'historique de crédits/abonnement et les fichiers data/u/<slug>/. Rien
 * d'un autre compte n'y figure ; une archive trop grosse est refusée (413).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-export-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.AUTH_ENABLED = "1";
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "0";
delete process.env.CORTEX_USER;

async function ownedCourse(id: string, owner: string, name: string) {
  const { insertCourse } = await import("../db/courses-store");
  await insertCourse({
    id, owner_user_id: owner, name, short: id.toUpperCase(), code: null, exam_name: name, exam_kind: "Final", university: null,
    university_lines: "[]", faculty: null, teachers: "[]", language: "fr", profile_id: null, duration_min: 120, exam_date: null,
    db_file: null, refs_rel: null, exams_rel: null, uploads_rel: null, content_rel: null, created_at: "2026-09-01 00:00:00",
  });
}

before(async () => {
  const { authRun } = await import("../db/auth-store");
  const { runWithUser, userSlug } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  const credits = await import("../lib/billing/credits");
  await ensureCoursesLoaded();
  await authRun(`INSERT INTO users (id, email, name) VALUES (?,?,?)`, "alice", "alice@example.com", "Alice");
  await authRun(`INSERT INTO users (id, email, name) VALUES (?,?,?)`, "bob", "bob@example.com", "Bob");
  await ownedCourse("reseaux", "alice", "Réseaux");
  await ownedCourse("bobcours", "bob", "Cours de Bob");
  await reloadCourses();
  await runWithUser("alice", () => runWithCourse("reseaux", () => q.run(`INSERT INTO weaknesses (topic, severity) VALUES (?, ?)`, "sous-réseaux alice", 3)));
  await runWithUser("bob", () => runWithCourse("bobcours", () => q.run(`INSERT INTO weaknesses (topic, severity) VALUES (?, ?)`, "bob-secret-topic", 3)));
  await credits.addTransaction("alice", 1000, "achat", "test:alice");
  await credits.addTransaction("bob", 500, "achat", "test:bob");
  for (const [u, c] of [["alice", "reseaux"], ["bob", "bobcours"]]) {
    const dir = path.join(tmp, "u", userSlug(u), c, "refs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${u}-annale.pdf`), `%PDF ${u}`);
  }
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["CORTEX_DATA_DIR", "DB_DRIVER", "DATABASE_URL", "AUTH_ENABLED", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "EXPORT_MAX_MB"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("writeAccountExport : profil, cours, crédits, tables du tenant en JSON — rien de bob", async () => {
  const { writeAccountExport } = await import("../lib/account-export");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-export-out-"));
  const r = await writeAccountExport("alice", out);
  assert.deepEqual(r.courses, ["reseaux"]);
  const profil = JSON.parse(fs.readFileSync(path.join(out, "export", "profil.json"), "utf8"));
  assert.equal(profil.user.email, "alice@example.com");
  const cours = JSON.parse(fs.readFileSync(path.join(out, "export", "cours.json"), "utf8"));
  assert.deepEqual(cours.map((c: { id: string }) => c.id), ["reseaux"]);
  const credits = JSON.parse(fs.readFileSync(path.join(out, "export", "credits.json"), "utf8"));
  assert.equal(credits.transactions.length, 1);
  assert.equal(credits.transactions[0].delta_centi, 1000);
  const weak = JSON.parse(fs.readFileSync(path.join(out, "export", "cours", "reseaux", "weaknesses.json"), "utf8"));
  assert.equal(weak.length, 1);
  assert.equal(weak[0].topic, "sous-réseaux alice");
  assert.ok(fs.existsSync(path.join(out, "export", "cours", "reseaux", "items.json")), "une table vide donne un tableau vide, pas une absence");
  let hits = "";
  try { hits = execFileSync("grep", ["-rl", "bob", out], { encoding: "utf8" }).trim(); } catch { hits = ""; } // grep : 1 = aucune occurrence
  assert.equal(hits, "", `données de bob présentes : ${hits}`);
  fs.rmSync(out, { recursive: true, force: true });
});

test("GET /api/account/export : 401 sans session ; 200 tar.gz en flux avec export/ et fichiers/ ; 413 au-delà de EXPORT_MAX_MB", async () => {
  const { GET } = await import("../app/api/account/export/route");
  const r401 = await GET(new NextRequest("http://cortex.test/api/account/export"));
  assert.equal(r401.status, 401);
  const r = await GET(new NextRequest("http://cortex.test/api/account/export", { headers: { "x-cortex-user": "alice" } }));
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(r.headers.get("content-type"), "application/gzip");
  assert.match(r.headers.get("content-disposition") ?? "", /attachment; filename="cortex-export-.*\.tar\.gz"/);
  const archive = path.join(tmp, "alice.tar.gz");
  fs.writeFileSync(archive, Buffer.from(await r.arrayBuffer()));
  const list = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  assert.match(list, /export\/profil\.json/);
  assert.match(list, /export\/cours\/reseaux\/weaknesses\.json/);
  assert.match(list, /fichiers\/reseaux\/refs\/alice-annale\.pdf/);
  assert.ok(!/bob/.test(list), list);
  await new Promise((r) => setTimeout(r, 300)); // le processus tar se ferme juste après la fin du flux
  process.env.EXPORT_MAX_MB = "0";
  const r413 = await GET(new NextRequest("http://cortex.test/api/account/export", { headers: { "x-cortex-user": "alice" } }));
  assert.equal(r413.status, 413);
  delete process.env.EXPORT_MAX_MB;
});
