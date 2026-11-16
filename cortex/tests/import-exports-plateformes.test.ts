/**
 * Exports de plateforme déposés tels quels : export Canvas (.imscc, un zip) et sauvegarde Moodle
 * (.mbz, un tar.gz dont les fichiers sont rangés par empreinte, leurs noms dans files.xml). Ils
 * étaient refusés en bloc (audit ingestion du 16/11/2026), comme les anciens formats Office, sans
 * dire quoi faire. Archives fictives construites ici.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import JSZip from "jszip";
import { LEGACY_REFUSAL, prepareCourseImport, prepareFolderImport } from "../lib/folder-import";

/** Une archive tar (ustar) minimale. */
function tar(entries: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(name === "pax_header" ? "x" : "0", 156);
    header.write("ustar\u000000", 257);
    const sum = [...header].reduce((a, b) => a + b, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const asFile = (data: Buffer | Uint8Array, name: string) => new File([new Uint8Array(data)], name);

test("export Canvas .imscc : développé comme un zip, sans les fichiers de description de la plateforme", async () => {
  const zip = new JSZip();
  zip.file("imsmanifest.xml", "<manifest/>");
  zip.file("course_settings/course_settings.xml", "<course/>");
  zip.file("web_resources/Week1/slides.pdf", "%PDF-1.4 semaine 1");
  zip.file("web_resources/Week2/serie.md", "# Série 2");
  const file = asFile(await zip.generateAsync({ type: "uint8array" }), "Analyse.imscc");
  const r = await prepareCourseImport([file]);
  assert.deepEqual(r.accepted.map((e) => e.relativePath), ["Analyse/web_resources/Week1/slides.pdf", "Analyse/web_resources/Week2/serie.md"]);
  assert.deepEqual(r.rejected, []);
});

test("sauvegarde Moodle .mbz : les fichiers reprennent leur vrai nom, les métadonnées sont ignorées", async () => {
  const filesXml = `<?xml version="1.0"?><files>
    <file id="1"><contenthash>aa11</contenthash><filepath>/</filepath><filename>chapitre-1.pdf</filename><filesize>18</filesize></file>
    <file id="2"><contenthash>bb22</contenthash><filepath>/series/</filepath><filename>serie-1.md</filename><filesize>9</filesize></file>
    <file id="3"><contenthash>da39a3ee</contenthash><filepath>/</filepath><filename>.</filename><filesize>0</filesize></file>
  </files>`;
  const archive = zlib.gzipSync(tar({
    "moodle_backup.xml": "<moodle_backup/>",
    "files.xml": filesXml,
    "files/aa/aa11": "%PDF-1.4 chapitre",
    "files/bb/bb22": "# Série 1",
    "activities/page_1/page.xml": "<page/>",
  }));
  const r = await prepareCourseImport([asFile(archive, "sauvegarde-cours.mbz")]);
  assert.deepEqual(r.accepted.map((e) => [e.relativePath, e.file.name]), [
    ["sauvegarde-cours/chapitre-1.pdf", "chapitre-1.pdf"],
    ["sauvegarde-cours/series/serie-1.md", "serie-1.md"],
  ]);
  assert.equal(await r.accepted[1].file.text(), "# Série 1");
  assert.deepEqual(r.rejected, []);
});

test("anciens formats Office et autres : refusés avec la consigne de ré-enregistrement", () => {
  const file = (name: string) => ({ name, size: 10, webkitRelativePath: `Cours/${name}` }) as File;
  const r = prepareFolderImport(["vieux.doc", "slides.ppt", "notes.odt", "texte.rtf", "livre.epub", "keynote.key"].map(file));
  assert.equal(r.accepted.length, 0);
  for (const x of r.rejected) assert.equal(x.reason, LEGACY_REFUSAL, x.name);
  assert.match(LEGACY_REFUSAL, /docx.*pdf/i);
});

test("sauvegarde Moodle : les entrées tar de métadonnées comptent dans les bornes (taille totale, nom long)", async () => {
  const big = "x".repeat(4096);
  const archive = zlib.gzipSync(tar({ "files.xml": "<files/>", "pax_header": big }));
  const r = await prepareCourseImport([asFile(archive, "bombe.mbz")], { maxTotalBytes: 2048 });
  assert.equal(r.accepted.length, 0);
  assert.match(r.rejected[0]?.reason ?? "", /taille décompressée totale/);
});
