/**
 * Import d'un dossier rangé par semaine (export Canvas, Moodle, zip) : deux fichiers de même nom
 * dans deux dossiers sont deux supports, et seul un contenu identique est un doublon (audit
 * ingestion du 16/11/2026 : « Week3/slides.pdf » refusé en 409, et un fichier de même taille
 * jeté sans rien dire). Vraie route d'import, cours fictif.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { prepareFolderImport } from "../lib/folder-import";
import { newCourse } from "./helpers/ingest-course";
import { textPdf } from "./helpers/pdf";
import { postForm } from "./helpers/route";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-import-doublons-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  delete process.env.MAX_COURSES_CREATED_PER_HOUR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("même nom dans deux semaines : deux supports ; même contenu : doublon signalé", async () => {
  const c = await newCourse("Orvelle semaines");
  const up = (data: Buffer, relpath: string) => postForm("sources/import", `course=${c.id}`, [[data, path.basename(relpath)]], { relpath });

  const w1 = await up(textPdf("Semaine 1 : ondes"), "Cours/Week1/slides.pdf");
  const w3 = await up(textPdf("Semaine 3 : ondes"), "Cours/Week3/slides.pdf");
  assert.equal(w1.status, 200, JSON.stringify(w1.json));
  assert.equal(w3.status, 200, JSON.stringify(w3.json));
  assert.deepEqual([w1.json.name, w3.json.name], ["slides.pdf", "slides-2.pdf"]);

  // Même taille, contenu différent : gardé.
  const s1 = await up(Buffer.from("Solutions semaine 1"), "Cours/Week1/solutions.md");
  const s2 = await up(Buffer.from("Solutions semaine 2"), "Cours/Week2/solutions.md");
  assert.deepEqual([s1.json.duplicate, s2.json.duplicate], [undefined, undefined]);
  assert.equal(s2.json.name, "solutions-2.md");

  // Contenu identique à un fichier déjà rangé : doublon, rien d'écrit.
  const again = await up(textPdf("Semaine 3 : ondes"), "Cours/Week4/slides.pdf");
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal(again.json.name, "slides-2.pdf");

  const stored = fs.readdirSync(path.join(c.contentRoot, "lectures")).sort();
  assert.deepEqual(stored, ["slides-2.pdf", "slides.pdf"]);
});

test("le navigateur n'écarte plus deux fichiers de même nom et même taille rangés dans deux dossiers", () => {
  const file = (name: string, size: number, rel: string) => ({ name, size, webkitRelativePath: rel }) as File;
  const r = prepareFolderImport([file("slides.pdf", 12, "Cours/Week1/slides.pdf"), file("slides.pdf", 12, "Cours/Week2/slides.pdf")]);
  assert.deepEqual(r.accepted.map((e) => e.relativePath), ["Cours/Week1/slides.pdf", "Cours/Week2/slides.pdf"]);
});

test("zone Annales : deux noms qui ne diffèrent que par leurs lettres non latines ne s'écrasent plus", async () => {
  process.env.E2E_TEST_AUTH = "1";
  process.env.E2E_TEST_RUN = "1";
  try {
    const c = await newCourse("Orvelle annales unicode");
    const r = await postForm("refs/upload", `course=${c.id}`, [
      [textPdf("Final 2023, exercice 1"), "期末考试2023.pdf"],
      [textPdf("Partiel 2023, exercice 1"), "期中考试2023.pdf"],
      [textPdf("Prüfung 2022"), "Prüfung_2022.pdf"],
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.files, ["____2023.pdf", "____2023-2.pdf", "Prufung_2022.pdf"]);
    assert.deepEqual(fs.readdirSync(c.refsDir).filter((f) => f.endsWith(".pdf")).sort(), ["Prufung_2022.pdf", "____2023-2.pdf", "____2023.pdf"]);
  } finally {
    delete process.env.E2E_TEST_AUTH;
    delete process.env.E2E_TEST_RUN;
  }
});
