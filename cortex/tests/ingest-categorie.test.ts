/**
 * La catégorie choisie par l'étudiant décide du type d'un support, le nom du fichier ne sert plus
 * qu'à l'année (audit ingestion du 16/11/2026) : un cours « Final review 2023 » déposé en Cours
 * devenait une annale 2023, comptée comme telle et base du format ; une note PDF devenait
 * « exercise ». Le vrai script d'ingestion, sur un cours fictif.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { textPdf } from "./helpers/pdf";
import { ingest, newCourse } from "./helpers/ingest-course";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-ingest-categorie-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  delete process.env.MAX_COURSES_CREATED_PER_HOUR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("le dossier de catégorie décide du type ; seules les vraies annales comptent comme annales", async () => {
  const c = await newCourse("Orvelle catégories");
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(c.contentRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(c.contentRoot, rel), textPdf(text));
  };
  put("lectures/Final_review_2023.pdf", "Révision des ondes de Orvelle");
  put("notes/Zusammenfassung.pdf", "Zusammenfassung der Orvelle-Wellen");
  put("series/Final_practice_2022.pdf", "Exercices d'entraînement");
  fs.writeFileSync(path.join(c.refsDir, "final-2021.pdf"), textPdf("Final 2021, exercice 1"));

  const r = ingest(c.id);
  assert.equal(r.status, 0, r.output);
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { pastExamCount } = await import("../lib/sources");
  const types = await runWithCourse(c.id, () => q.all<{ path: string; type: string }>(`SELECT path, type FROM sources ORDER BY path`));
  assert.deepEqual(Object.fromEntries(types.map((t) => [t.path, t.type])), {
    "lectures/Final_review_2023.pdf": "course_pdf",
    "notes/Zusammenfassung.pdf": "note",
    "refs/final-2021.pdf": "final",
    "series/Final_practice_2022.pdf": "serie",
  });
  assert.equal(await runWithCourse(c.id, () => pastExamCount()), 1);
});

test("sans dossier de catégorie, le même classifieur que l'import : un projet « final » n'est pas une annale", async () => {
  const c = await newCourse("Orvelle sans catégorie");
  fs.mkdirSync(path.join(c.contentRoot, "misc"), { recursive: true });
  fs.writeFileSync(path.join(c.contentRoot, "misc", "final-project-2024.pdf"), textPdf("Consignes du projet"));
  fs.writeFileSync(path.join(c.contentRoot, "misc", "Klausur_WS2023.pdf"), textPdf("Aufgabe 1"));
  const r = ingest(c.id);
  assert.equal(r.status, 0, r.output);
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const rows = await runWithCourse(c.id, () => q.all<{ path: string; type: string; year: number | null }>(`SELECT path, type, year FROM sources ORDER BY path`));
  assert.deepEqual(rows.map((x) => [x.path, x.type, x.year]), [
    ["misc/Klausur_WS2023.pdf", "final", 2023],
    ["misc/final-project-2024.pdf", "exercise", null],
  ]);
});
