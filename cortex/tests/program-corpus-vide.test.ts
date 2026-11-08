/**
 * Préparation d'un cours aux supports illisibles — banc moteur du 04/11/2026 (synth-scan) : un PDF
 * scanné, sans couche texte, donnait « Corpus vide : ingère d'abord le cours … avec « npm run
 * ingest » » — une commande de développeur, et faux : le cours était déposé. Le message dit
 * désormais ce qui se passe et quoi faire.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-corpus-vide-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
after(() => {
  delete process.env.CORTEX_DATA_DIR;
  delete process.env.MAX_COURSES_CREATED_PER_HOUR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function course(name: string, withSource: boolean): Promise<string> {
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const row = buildCourseRow({ name, language: "fr" }, "owner");
  await insertCourse(row);
  await reloadCourses();
  if (withSource) {
    const { runWithCourse } = await import("../db/client");
    const { q } = await import("../db/q");
    await runWithCourse(row.id, async () => {
      await q.ensureTable("sources");
      await q.ensureTable("items");
      // Un PDF scanné : la source existe, aucune page n'a donné de texte.
      await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", "cours-scan", "lectures/cours-scan.pdf", null, 1);
    });
  }
  return row.id;
}

test("supports déposés mais sans texte lisible : le message parle de PDF scannés, pas de « npm run ingest »", async () => {
  const id = await course("Cours scanné", true);
  const { runWithCourse } = await import("../db/client");
  const { analyzeBlueprint } = await import("../lib/program");
  await assert.rejects(runWithCourse(id, () => analyzeBlueprint()), (e: Error) => /scann/i.test(e.message) && /cours-scan/.test(e.message) && !/npm run/.test(e.message));
});

test("aucun support du tout : le message invite à les déposer, sans commande de développeur", async () => {
  const id = await course("Cours vide", false);
  const { runWithCourse } = await import("../db/client");
  const { analyzeBlueprint } = await import("../lib/program");
  await assert.rejects(runWithCourse(id, () => analyzeBlueprint()), (e: Error) => /dépose/i.test(e.message) && !/npm run/.test(e.message));
});
