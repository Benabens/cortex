/**
 * Ingestion d'un polycopié d'un seul fichier : un support par chapitre (lib/chapters) — banc moteur
 * du 04/11/2026, synth-docx : un DOCX de 8 chapitres donnait un seul support, et l'examen posait
 * 12 questions sur 12 dans le chapitre 1. Le vrai script d'ingestion, sur un cours synthétique.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-ingest-chap-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  delete process.env.MAX_COURSES_CREATED_PER_HOUR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("un DOCX de 6 chapitres donne 6 supports titrés, dans l'ordre ; un exemple court reste entier", async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded, reloadCourses, coursePaths } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const row = buildCourseRow({ name: "Veltrane polycopié", language: "fr" }, "owner");
  await insertCourse(row);
  await reloadCourses();
  const { synthCourse, writeCourseFiles } = await import("../lib/bench/synth");
  const lectures = path.join(coursePaths(row.id).contentRoot, "lectures");
  await writeCourseFiles(synthCourse({ seed: 7, chapters: 6, conceptsPerChapter: 4, language: "fr" }), lectures, "docx");
  fs.writeFileSync(path.join(lectures, "rappel.md"), "Chapitre 1 : rappel\nUn court rappel. Chapitre 2 : suite\nFin. Chapitre 3 : fin\nFin.");

  const r = spawnSync(path.join(process.cwd(), "node_modules", ".bin", "tsx"), ["scripts/ingest.ts", `--course=${row.id}`], { env: { ...process.env, CORTEX_COURSE: row.id }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);

  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const sources = await runWithCourse(row.id, () => q.all<{ title: string; type: string }>(`SELECT title, type FROM sources ORDER BY id`));
  const chapters = sources.filter((s) => s.title.startsWith("cours — "));
  assert.equal(chapters.length, 6, sources.map((s) => s.title).join("\n"));
  assert.match(chapters[0].title, /^cours — Chapitre 1 : /);
  assert.match(chapters[5].title, /^cours — Chapitre 6 : /);
  assert.ok(sources.some((s) => s.title === "rappel.md"), "un document court n'est pas découpé");
});
