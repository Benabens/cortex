/**
 * PPTX : les diapositives sortaient dans l'ordre des fichiers internes (slide1.xml, slide2.xml…),
 * pas dans celui de la présentation, et les notes de l'orateur (souvent l'explication de
 * l'enseignant) étaient perdues — audit ingestion du 16/11/2026, P2. Présentation fictive.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import { extractOfficeText } from "../lib/office-documents";

const NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const shape = (text: string, ph = "") => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const rels = (items: { id: string; type: string; target: string }[]) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map((r) => `<Relationship Id="${r.id}" Type="${REL}/${r.type}" Target="${r.target}"/>`).join("")}</Relationships>`;

/** slide1 = « Conclusion », slide2 = « Method », slide3 = « Intro », montrées dans l'ordre 3, 2, 1. */
async function reorderedDeck(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId7"/><p:sldId id="257" r:id="rId5"/><p:sldId id="258" r:id="rId6"/></p:sldIdLst></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", rels([
    { id: "rId6", type: "slide", target: "slides/slide1.xml" },
    { id: "rId5", type: "slide", target: "slides/slide2.xml" },
    { id: "rId7", type: "slide", target: "/ppt/slides/slide3.xml" },
    { id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
  ]));
  const slide = (text: string) => `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>${shape(text)}</p:spTree></p:cSld></p:sld>`;
  zip.file("ppt/slides/slide1.xml", slide("Conclusion"));
  zip.file("ppt/slides/slide2.xml", slide("Method"));
  zip.file("ppt/slides/slide3.xml", slide("Intro"));
  zip.file("ppt/slides/_rels/slide2.xml.rels", rels([{ id: "rId2", type: "notesSlide", target: "../notesSlides/notesSlide1.xml" }]));
  // Notes : l'aperçu de la diapositive (sldImg) et le numéro de page ne sont pas du texte de l'enseignant.
  zip.file("ppt/notesSlides/notesSlide1.xml", `<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree>${shape("", '<p:ph type="sldImg"/>')}${shape("Key exam trap: the base case is n = 0", '<p:ph type="body" idx="1"/>')}${shape("2", '<p:ph type="sldNum" idx="12"/>')}</p:spTree></p:cSld></p:notes>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

test("PPTX : les diapositives sortent dans l'ordre de la présentation", async () => {
  const text = await extractOfficeText(await reorderedDeck(), ".pptx");
  const order = ["Intro", "Method", "Conclusion"].map((t) => text.indexOf(t));
  assert.ok(order.every((i) => i >= 0), text);
  assert.deepEqual([...order].sort((a, b) => a - b), order, `ordre attendu Intro, Method, Conclusion : ${JSON.stringify(text)}`);
});

test("PPTX : les notes de l'orateur suivent leur diapositive, sans le numéro de page", async () => {
  const text = await extractOfficeText(await reorderedDeck(), ".pptx");
  assert.match(text, /Method\n+Notes: Key exam trap: the base case is n = 0\n+Conclusion/);
  assert.doesNotMatch(text, /Notes: [^\n]*\b2\s*$/m, "le numéro de page des notes n'est pas lu");
});
