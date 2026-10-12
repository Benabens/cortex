import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-docx-"));
process.env.CORTEX_DATA_DIR = tmp;

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function docx(text: string, extraUncompressedBytes = 0): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  if (extraUncompressedBytes) zip.file("word/media/piege.bin", "0".repeat(extraUncompressedBytes));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

test("un DOCX valide produit le texte destiné à la source", async () => {
  const { extractOfficeText } = await import("../lib/office-documents");
  const result = await extractOfficeText(await docx("La photosynthèse transforme la lumière."), ".docx");
  assert.equal(result, "La photosynthèse transforme la lumière.");
});

test("un DOCX valide crée une source et un item recherchable", async () => {
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { rawDb } = await import("../db/client");
  const { allDdl } = await import("../db/tables");
  for (const statement of allDdl("sqlite")) {
    try { rawDb().exec(statement); } catch { /* dépendances de schéma paresseuses */ }
  }
  const { REFS_DIR, ingestRefFile } = await import("../lib/sources");
  const refs = REFS_DIR();
  fs.mkdirSync(refs, { recursive: true });
  fs.writeFileSync(path.join(refs, "final-2026.docx"), await docx("Définir une structure de données persistante."));
  await ingestRefFile("refs/final-2026.docx");
  const { q } = await import("../db/q");
  const source = await q.get<{ type: string; title: string }>("SELECT type, title FROM sources WHERE path = ?", "refs/final-2026.docx");
  const item = await q.get<{ text: string }>("SELECT text FROM items WHERE source_id = (SELECT id FROM sources WHERE path = ?)", "refs/final-2026.docx");
  assert.deepEqual(source, { type: "final", title: "final-2026" });
  assert.match(item?.text ?? "", /structure de données persistante/);
});

test("un DOCX corrompu est refusé avec une erreur client explicite", async () => {
  const { extractOfficeText, OfficeDocumentError } = await import("../lib/office-documents");
  await assert.rejects(
    extractOfficeText(Buffer.from("ceci n'est pas une archive"), ".docx"),
    (error: unknown) => error instanceof OfficeDocumentError && error.status === 422 && /corrompu/i.test(error.message),
  );
});

test("un DOCX à taille décompressée excessive est refusé avant extraction", async () => {
  const { extractOfficeText, OfficeDocumentError } = await import("../lib/office-documents");
  const bomb = await docx("Petit texte", 1024 * 1024);
  await assert.rejects(
    extractOfficeText(bomb, ".docx", { maxUncompressedBytes: 128 * 1024 }),
    (error: unknown) => error instanceof OfficeDocumentError && error.status === 413 && /décompress/i.test(error.message),
  );
});
