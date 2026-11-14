import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import {
  SOURCE_FILE_MAX_BYTES,
  prepareCourseImport,
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

async function archive(name: string, entries: Record<string, string | Uint8Array>): Promise<File> {
  const zip = new JSZip();
  for (const [entry, data] of Object.entries(entries)) zip.file(entry, data);
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return new File([bytes.slice().buffer as ArrayBuffer], name, { type: "application/zip" });
}

test("une archive est décompressée avec ses sous-dossiers et une archive imbriquée", async () => {
  const nested = await archive("series.zip", { "semaine 1/serie.md": "# Série" });
  const moodle = await archive("moodle.zip", {
    "Cours/chapitre.pdf": "%PDF-1.4 cours",
    "Cours/__MACOSX/._chapitre.pdf": "metadata",
    "Cours/.cache/secret.txt": "secret",
    "Cours/copie/chapitre.pdf": "%PDF-1.4 cours",
    "Cours/programme.exe": "non",
    "Cours/series.zip": new Uint8Array(await nested.arrayBuffer()),
  });

  const result = await prepareCourseImport([moodle]);
  assert.deepEqual(result.accepted.map((entry) => entry.relativePath), [
    "moodle/Cours/chapitre.pdf",
    "moodle/Cours/series/semaine 1/serie.md",
  ]);
  assert.deepEqual(result.rejected.map((entry) => entry.reason), [
    "fichier caché ignoré",
    "fichier caché ignoré",
    "doublon ignoré",
    "format non pris en charge",
  ]);
});

test("les chemins dangereux et les archives au-delà d'un niveau sont refusés", async () => {
  const deep = await archive("profond.zip", { "cours.txt": "cours" });
  const nested = await archive("niveau-1.zip", { "niveau-2.zip": new Uint8Array(await deep.arrayBuffer()) });
  const hostile = await archive("hostile.zip", {
    "../hors-cours.txt": "attaque",
    "/absolu.pdf": "%PDF-1.4",
    "C:\\absolu.txt": "attaque",
    "niveau-1.zip": new Uint8Array(await nested.arrayBuffer()),
  });

  const result = await prepareCourseImport([hostile]);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.filter((entry) => /chemin dangereux/.test(entry.reason)).length, 3);
  assert.match(result.rejected.at(-1)?.reason ?? "", /archives imbriquées limitées à un niveau/);
});

test("les plafonds d'une archive portent sur les extraits, le nombre et le ratio", async () => {
  const tooLarge = await archive("gros.zip", { "gros.txt": "x".repeat(101) });
  const sizeResult = await prepareCourseImport([tooLarge], { maxEntryBytes: 100, maxTotalBytes: 1_000, maxEntries: 10, maxRatio: 1_000 });
  assert.match(sizeResult.rejected[0].reason, /100 octets maximum par fichier extrait/);

  const tooMany = await archive("nombre.zip", { "a.txt": "a", "b.txt": "b", "c.txt": "c" });
  const countResult = await prepareCourseImport([tooMany], { maxEntryBytes: 100, maxTotalBytes: 1_000, maxEntries: 2, maxRatio: 1_000 });
  assert.match(countResult.rejected[0].reason, /trop de fichiers/);

  const bombZip = new JSZip();
  bombZip.file("cours.txt", "a".repeat(20_000), { compression: "DEFLATE" });
  bombZip.file("padding.bin", Uint8Array.from({ length: 20_000 }, (_, index) => index % 251), { compression: "STORE" });
  const bombBytes = await bombZip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const bomb = new File([bombBytes.slice().buffer as ArrayBuffer], "bombe-rembourree.zip");
  const ratioResult = await prepareCourseImport([bomb], { maxEntryBytes: 30_000, maxTotalBytes: 50_000, maxEntries: 10, maxRatio: 2 });
  assert.match(ratioResult.rejected[0].reason, /ratio de décompression/);
});

test("les noms ZIP UTF-8 et CP437 sont décodés", async () => {
  const utf8 = await archive("utf8.zip", { "résumé.md": "cours" });
  const zip = new JSZip();
  zip.file("x.txt", "cours");
  const cp437 = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
  for (let index = 0; index <= cp437.length - 5; index++) {
    if (cp437[index] === 0x78 && cp437[index + 1] === 0x2e && cp437[index + 2] === 0x74 && cp437[index + 3] === 0x78 && cp437[index + 4] === 0x74) cp437[index] = 0x82;
  }
  const legacy = new File([cp437.slice().buffer as ArrayBuffer], "legacy.zip", { type: "application/zip" });

  const result = await prepareCourseImport([utf8, legacy]);
  assert.deepEqual(result.accepted.map((entry) => entry.relativePath), ["utf8/résumé.md", "legacy/é.txt"]);
});
