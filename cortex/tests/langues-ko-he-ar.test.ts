/**
 * CORÉEN, HÉBREU, ARABE comme langue de cours/examen (backend). L'infra de rendu (polices,
 * balisage bidi) existe déjà ; ce qui manquait : ces trois langues dans LANGUAGES/detectLanguage
 * (tests/exam-format.test.ts) et leurs libellés de garde (ce fichier). Cours et examen FICTIFS
 * (tests/helpers/gabarits.ts), hors EPFL (gabarit neutre, cf. tests/gabarit-neutre.test.ts).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-langues-koar-"));
process.env.CORTEX_DATA_DIR = tmp;

const COURSES: Record<"ko" | "he" | "ar", string> = { ko: "", he: "", ar: "" };

before(async () => {
  delete process.env.CORTEX_USER;
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  for (const lang of ["ko", "he", "ar"] as const) {
    const row = buildCourseRow({ name: `Cours fictif ${lang}`, university: "Testville University", language: lang, examFormat: { kind: "exercises", durationMin: 90 } }, "owner");
    await insertCourse(row);
    COURSES[lang] = row.id;
  }
  await reloadCourses();
});

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function inCourse<T>(course: string, fn: () => T | Promise<T>): Promise<T> {
  const { runWithCourse } = await import("../db/client");
  return runWithCourse(course, async () => fn());
}

function body(tex: string): string {
  return tex.slice(tex.lastIndexOf(String.raw`\begin{document}`));
}

/** Un libellé par langue, indépendant de l'implémentation (traduction vérifiée à la main). */
const NAME_LABEL: Record<"ko" | "he" | "ar", string> = { ko: "이름:", he: "שם:", ar: "الاسم:" };

test("examen hors EPFL : garde neutre en coréen, hébreu et arabe, avec leurs propres libellés", async () => {
  const { renderExamTex } = await import("../lib/exam-latex");
  const { WRITTEN_SPEC, DATE } = await import("./helpers/gabarits");
  for (const lang of ["ko", "he", "ar"] as const) {
    const tex = await inCourse(COURSES[lang], () => renderExamTex(WRITTEN_SPEC as never, DATE, true));
    const page = body(tex);
    assert.match(page, new RegExp(NAME_LABEL[lang].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(page, /epfl|SCIPER/i);
  }
});
