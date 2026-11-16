/**
 * Au dépôt, un PDF qui ne s'ouvre pas (abîmé, chiffré) est refusé avec une consigne claire, et
 * n'est jamais rangé dans le cours : c'est ce fichier qui bloquait ensuite toutes les ingestions
 * (audit ingestion du 16/11/2026, P0). Vraies routes d'import, cours fictif, aucun appel au modèle.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { NextRequest } from "next/server";
import { corruptPdf, encryptedPdf, textPdf } from "./helpers/pdf";
import { postForm } from "./helpers/route";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-depot-illisible-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
// Pas de job de format après un dépôt d'annale (il appellerait le modèle).
process.env.E2E_TEST_AUTH = "1";
process.env.E2E_TEST_RUN = "1";

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "MAX_COURSES_CREATED_PER_HOUR", "E2E_TEST_AUTH", "E2E_TEST_RUN"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

let course: { id: string; refsDir: string; contentRoot: string } | null = null;
async function theCourse() {
  if (course) return course;
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded, reloadCourses, coursePaths } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const row = buildCourseRow({ name: "Orvelle dépôts", language: "fr" }, "owner");
  await insertCourse(row);
  await reloadCourses();
  course = { id: row.id, ...coursePaths(row.id) };
  return course;
}

async function post(route: string, query: string, files: [Buffer, string][], fields: Record<string, string> = {}) {
  const c = await theCourse();
  return postForm(route, `course=${c.id}${query}`, files, fields);
}

function storedFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
}

test("import de dossier : un PDF abîmé ou chiffré est refusé en 422, et rien n'est rangé", async () => {
  const c = await theCourse();
  const bad = await post("sources/import", "", [[corruptPdf(), "final-2023.pdf"]], { relpath: "Cours/Exams/final-2023.pdf" });
  assert.equal(bad.status, 422, JSON.stringify(bad.json));
  assert.match(bad.json.error, /final-2023\.pdf : .*abîmé/);
  const locked = await post("sources/import", "", [[encryptedPdf(), "chapitre-2.pdf"]], { relpath: "Cours/lectures/chapitre-2.pdf" });
  assert.equal(locked.status, 422);
  assert.match(locked.json.error, /mot de passe/);
  const good = await post("sources/import", "", [[textPdf("Chapitre 1 : les ondes"), "chapitre-1.pdf"]], { relpath: "Cours/lectures/chapitre-1.pdf" });
  assert.equal(good.status, 200, JSON.stringify(good.json));
  assert.deepEqual([...storedFiles(c.refsDir), ...storedFiles(c.contentRoot)], ["chapitre-1.pdf"]);
});

test("zone Annales : chaque fichier écarté est nommé avec sa raison, et le PDF abîmé ne reste pas dans les annales", async () => {
  const c = await theCourse();
  const r = await post("refs/upload", "", [
    [textPdf("Final 2022, exercice 1"), "final-2022.pdf"],
    [corruptPdf(), "final-2019.pdf"],
    [encryptedPdf(), "final-2020.pdf"],
    [Buffer.from("PNG"), "photo.png"],
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.files, ["final-2022.pdf"]);
  const skipped = Object.fromEntries((r.json.skipped as { file: string; reason: string }[]).map((s) => [s.file, s.reason]));
  assert.deepEqual(Object.keys(skipped).sort(), ["final-2019.pdf", "final-2020.pdf", "photo.png"]);
  assert.match(skipped["final-2019.pdf"], /abîmé/);
  assert.match(skipped["final-2020.pdf"], /mot de passe/);
  assert.match(skipped["photo.png"], /image/);
  assert.deepEqual(storedFiles(c.refsDir), ["final-2022.pdf"]);
});

test("questions d'exemple, consignes et connecteur : le même refus pour un PDF abîmé", async () => {
  const c = await theCourse();
  const { addFileSource, SourceError } = await import("../lib/course-source");
  await assert.rejects(
    addFileSource(c.id, { name: "exemples.pdf", data: corruptPdf(), category: "sample_questions", contentType: "application/pdf" }),
    (e: unknown) => e instanceof SourceError && e.status === 422 && /abîmé/.test(e.message),
  );
  assert.ok(!storedFiles(c.contentRoot).includes("exemples.pdf"));
});

test("un fichier illisible déjà rangé (dépôt d'avant ce contrôle) se retire depuis la liste des fichiers non lus", async () => {
  const c = await theCourse();
  fs.mkdirSync(path.join(c.contentRoot, "lectures"), { recursive: true });
  fs.mkdirSync(c.refsDir, { recursive: true });
  fs.writeFileSync(path.join(c.refsDir, "final-2018.pdf"), corruptPdf());
  fs.writeFileSync(path.join(c.contentRoot, "lectures", "vieux.pdf"), corruptPdf());
  const mod = await import("../app/api/sources/route");
  const del = async (p: string) => (await mod.DELETE(new NextRequest(`http://cortex.test/api/sources?course=${c.id}&path=${encodeURIComponent(p)}`, { method: "DELETE" }))).status;
  assert.equal(await del("refs/final-2018.pdf"), 200);
  assert.equal(await del("lectures/vieux.pdf"), 200);
  assert.ok(!storedFiles(c.refsDir).includes("final-2018.pdf"));
  assert.ok(!storedFiles(c.contentRoot).includes("vieux.pdf"));
  // Un chemin hors du cours ne touche à rien.
  fs.writeFileSync(path.join(tmp, "dehors.pdf"), "x");
  await del("../../dehors.pdf");
  assert.ok(fs.existsSync(path.join(tmp, "dehors.pdf")));
});

test("retirer un fichier : un chemin d'annale en sous-dossier ne supprime jamais l'annale du même nom", async () => {
  const c = await theCourse();
  fs.mkdirSync(c.refsDir, { recursive: true });
  fs.writeFileSync(path.join(c.refsDir, "final-2017.pdf"), textPdf("Final 2017, exercice 1"));
  const { runWithCourse } = await import("../db/client");
  const { ingestRefFile } = await import("../lib/sources");
  await runWithCourse(c.id, () => ingestRefFile("refs/final-2017.pdf"));
  const mod = await import("../app/api/sources/route");
  await mod.DELETE(new NextRequest(`http://cortex.test/api/sources?course=${c.id}&path=${encodeURIComponent("refs/x/final-2017.pdf")}`, { method: "DELETE" }));
  assert.ok(storedFiles(c.refsDir).includes("final-2017.pdf"));
});

test("retirer un scan sans texte (contenu ou annale) supprime bien le fichier : il ne revient pas au rapport suivant", async () => {
  const c = await theCourse();
  fs.mkdirSync(path.join(c.contentRoot, "lectures"), { recursive: true });
  fs.writeFileSync(path.join(c.contentRoot, "lectures", "scan.pdf"), textPdf(null));
  fs.writeFileSync(path.join(c.refsDir, "final-2016.pdf"), textPdf(null));
  const { ingest } = await import("./helpers/ingest-course");
  const r = ingest(c.id);
  assert.equal(r.files?.find((f) => f.path === "lectures/scan.pdf")?.status, "no_text", r.output);
  assert.equal(r.files?.find((f) => f.path === "refs/final-2016.pdf")?.status, "no_text");
  const mod = await import("../app/api/sources/route");
  const del = async (p: string) => (await mod.DELETE(new NextRequest(`http://cortex.test/api/sources?course=${c.id}&path=${encodeURIComponent(p)}`, { method: "DELETE" }))).status;
  assert.equal(await del("lectures/scan.pdf"), 200);
  assert.equal(await del("refs/final-2016.pdf"), 200);
  assert.ok(!storedFiles(c.contentRoot).includes("scan.pdf"));
  assert.ok(!storedFiles(c.refsDir).includes("final-2016.pdf"));
});
