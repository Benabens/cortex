import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COURSE_IMPORT_MAX_BYTES,
  SOURCE_FILE_MAX_BYTES,
  prepareFolderImport,
} from "../lib/folder-import";

function file(name: string, size: number, relativePath = name): File {
  const value = new File([new Uint8Array(size)], name);
  Object.defineProperty(value, "webkitRelativePath", { value: relativePath });
  return value;
}

test("l'import de dossier ignore les fichiers cachés, les formats inconnus et les doublons", () => {
  const result = prepareFolderImport([
    file("cours.pdf", 12, "Analyse 3/chapitre/cours.pdf"),
    file("cours.pdf", 12, "Analyse 3/copie/cours.pdf"),
    file(".DS_Store", 4, "Analyse 3/.DS_Store"),
    file("secret.pdf", 4, "Analyse 3/.cache/secret.pdf"),
    file("programme.exe", 4, "Analyse 3/programme.exe"),
    file("scan.png", 8, "Analyse 3/scans/scan.png"),
  ]);

  assert.deepEqual(result.accepted.map((entry) => entry.relativePath), [
    "Analyse 3/chapitre/cours.pdf",
    "Analyse 3/scans/scan.png",
  ]);
  assert.deepEqual(result.rejected.map((entry) => entry.reason), [
    "doublon ignoré",
    "fichier caché ignoré",
    "fichier caché ignoré",
    "format non pris en charge",
  ]);
});

test("les limites par fichier et par cours produisent une raison actionnable", () => {
  const tooLarge = prepareFolderImport([file("video.pdf", SOURCE_FILE_MAX_BYTES + 1)]);
  assert.match(tooLarge.rejected[0].reason, /30 Mo maximum par fichier/);

  const files = Array.from({ length: 6 }, (_, index) =>
    file(`partie-${index}.pdf`, 30 * 1024 * 1024, `cours/partie-${index}.pdf`),
  );
  const overCourse = prepareFolderImport(files);
  assert.equal(overCourse.accepted.reduce((sum, entry) => sum + entry.file.size, 0), COURSE_IMPORT_MAX_BYTES);
  assert.match(overCourse.rejected[0].reason, /150 Mo maximum par cours/);
});
