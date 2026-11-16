/**
 * Formules Word / PowerPoint (OMML) : elles disparaissaient du texte extrait, et la phrase se
 * recollait sans elles (« Energy isfor a body at rest. ») — audit ingestion du 16/11/2026. Elles
 * sortent maintenant en LaTeX linéaire, à leur place. Documents fictifs construits ici.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import { extractOfficeText } from "../lib/office-documents";

const M = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
const r = (t: string) => `<m:r><m:t>${t}</m:t></m:r>`;
const sup = (base: string, exp: string) => `<m:sSup><m:e>${r(base)}</m:e><m:sup>${r(exp)}</m:sup></m:sSup>`;
const EMC2 = `<m:oMath>${r("E=m")}${sup("c", "2")}</m:oMath>`;
const BAYES = `<m:oMath>${r("P")}<m:d><m:e>${r("A|B")}</m:e></m:d>${r("=")}<m:f><m:num>${r("P")}<m:d><m:e>${r("B|A")}</m:e></m:d>${r("P")}<m:d><m:e>${r("A")}</m:e></m:d></m:num><m:den>${r("P")}<m:d><m:e>${r("B")}</m:e></m:d></m:den></m:f></m:oMath>`;
const ROOT = `<m:oMathPara><m:oMath><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${r("x")}</m:e></m:rad></m:oMath></m:oMathPara>`;

async function docx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ${M}><w:body>${paragraphs.map((p) => `<w:p>${p}</w:p>`).join("")}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function pptx(slideBody: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ${M}><p:cSld><p:spTree><p:sp><p:txBody><a:p>${slideBody}</a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

const run = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;

test("DOCX : la formule reste dans la phrase, en LaTeX linéaire", async () => {
  const text = await extractOfficeText(await docx([`${run("Energy is ")}${EMC2}${run(" for a body at rest.")}`, ROOT]), ".docx");
  assert.match(text, /Energy is \$E=m\{c\}\^\{2\}\$ for a body at rest\./);
  assert.match(text, /\$\\sqrt\{x\}\$/);
});

test("PPTX : fractions et délimiteurs de la formule de Bayes conservés", async () => {
  const body = `<a:r><a:t>Bayes : </a:t></a:r><mc:AlternateContent><mc:Choice Requires="a14"><a14:m>${BAYES}</a14:m></mc:Choice><mc:Fallback><a:r><a:t>[image]</a:t></a:r></mc:Fallback></mc:AlternateContent>`;
  const text = await extractOfficeText(await pptx(body), ".pptx");
  assert.match(text, /Bayes :\s+\$P\(A\|B\)=\\frac\{P\(B\|A\)P\(A\)\}\{P\(B\)\}\$/);
  assert.doesNotMatch(text, /\[image\]/, "la copie image de secours n'est pas lue en double");
});
