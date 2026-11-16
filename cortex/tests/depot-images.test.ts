/**
 * Une photo ou une image n'est jamais lue (pas d'OCR) : elle est refusée au dépôt, avec une
 * consigne, au lieu d'être envoyée, comptée dans le quota puis ignorée (audit ingestion du
 * 16/11/2026). Une photo d'annale n'est plus rangée dans les annales.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { prepareFolderImport } from "../lib/folder-import";
import { classifyFile } from "../lib/import-folder";
import { newCourse } from "./helpers/ingest-course";
import { postForm } from "./helpers/route";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-depot-images-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  delete process.env.MAX_COURSES_CREATED_PER_HOUR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const file = (name: string, size: number, rel: string) => ({ name, size, webkitRelativePath: rel }) as File;

test("le navigateur écarte les photos avec la consigne, iPhone compris", () => {
  const r = prepareFolderImport([
    file("exam_2023_p1.jpg", 10, "Cours/exam_2023_p1.jpg"),
    file("tableau.png", 10, "Cours/tableau.png"),
    file("IMG_0001.HEIC", 10, "Cours/IMG_0001.HEIC"),
    file("cours.pdf", 10, "Cours/cours.pdf"),
  ]);
  assert.deepEqual(r.accepted.map((e) => e.relativePath), ["Cours/cours.pdf"]);
  assert.equal(r.rejected.length, 3);
  for (const x of r.rejected) assert.match(x.reason, /image.*PDF/);
});

test("une photo d'annale n'est pas classée annale", () => {
  assert.equal(classifyFile("exam_2023_p1.jpg").bucket, "images");
});

test("import et zone Annales : une image est refusée avec la même consigne", async () => {
  const c = await newCourse("Orvelle images");
  const imp = await postForm("sources/import", `course=${c.id}`, [[Buffer.from("PNG"), "exam_2023_p1.png"]], { relpath: "Cours/exam_2023_p1.png" });
  assert.equal(imp.status, 415);
  assert.match(imp.json.error, /exam_2023_p1\.png : .*image.*PDF/);
  assert.ok(!fs.existsSync(c.refsDir) || !fs.readdirSync(c.refsDir).some((f) => f.endsWith(".png")));
  process.env.E2E_TEST_AUTH = "1";
  process.env.E2E_TEST_RUN = "1";
  try {
    const refs = await postForm("refs/upload", `course=${c.id}`, [[Buffer.from("JPG"), "final-2023.jpg"]]);
    assert.equal(refs.status, 400);
    assert.match(refs.json.skipped[0].reason, /image.*PDF/);
  } finally {
    delete process.env.E2E_TEST_AUTH;
    delete process.env.E2E_TEST_RUN;
  }
});
