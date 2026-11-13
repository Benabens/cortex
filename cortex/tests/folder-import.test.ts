import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SOURCE_FILE_MAX_BYTES,
  prepareFolderImport,
} from "../lib/folder-import";

function file(name: string, size: number, relativePath = name): File {
  return { name, size, webkitRelativePath: relativePath } as File;
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

test("la limite par fichier est actionnable sans bloquer un dossier de 300 Mo", () => {
  const tooLarge = prepareFolderImport([file("video.pdf", SOURCE_FILE_MAX_BYTES + 1)]);
  assert.match(tooLarge.rejected[0].reason, /30 Mo maximum par fichier/);

  const files = Array.from({ length: 10 }, (_, index) =>
    file(`partie-${index}.pdf`, 30 * 1024 * 1024, `cours/partie-${index}.pdf`),
  );
  const largeCourse = prepareFolderImport(files);
  assert.equal(largeCourse.accepted.length, 10);
  assert.equal(largeCourse.rejected.length, 0);
});
