import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Pièces jointes de la zone de dépôt Faiblesses : le type se reconnaît aux octets (jamais au nom
 * ni au type MIME annoncé), et le texte d'un PDF s'extrait sur le serveur.
 */

/** PDF minimal valide (une page, une ligne de texte), offsets de xref calculés. */
function tinyPdf(line: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test("type reconnu aux octets : PNG, JPG, GIF, WEBP, PDF ; le reste est refusé", async () => {
  const { sniffAttachment, isImage } = await import("../lib/weakness-files");
  const b = (...xs: number[]) => new Uint8Array(xs);
  const s = (str: string) => new TextEncoder().encode(str);
  assert.equal(sniffAttachment(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), "png");
  assert.equal(sniffAttachment(b(0xff, 0xd8, 0xff, 0xe0)), "jpg");
  assert.equal(sniffAttachment(s("GIF89a....")), "gif");
  assert.equal(sniffAttachment(s("RIFF\0\0\0\0WEBPVP8 ")), "webp");
  assert.equal(sniffAttachment(tinyPdf("x")), "pdf");
  assert.equal(sniffAttachment(s("\n\n%PDF-1.7 en-tête décalé")), "pdf");
  // Un exécutable ou un HTML renommé en .png n'est plus rangé en image.
  assert.equal(sniffAttachment(s("<html><script>alert(1)</script>")), null);
  assert.equal(sniffAttachment(b(0x4d, 0x5a, 0x90, 0x00)), null);
  assert.equal(isImage("png"), true);
  assert.equal(isImage("pdf"), false);
  assert.equal(isImage(null), false);
});

test("PDF : le texte est extrait sur le serveur, espaces normalisés et plafonné", async () => {
  const { pdfText } = await import("../lib/weakness-files");
  const pdf = tinyPdf("Exercice 3 : descente de gradient avec un pas trop grand");
  const text = await pdfText(pdf, 1000);
  assert.match(text, /Exercice 3 : descente de gradient avec un pas trop grand/);
  assert.equal((await pdfText(pdf, 12)).length, 12);
});

test("PDF illisible ou corrompu : chaîne vide (repli « gardé tel quel »), jamais d'exception", async () => {
  const { pdfText } = await import("../lib/weakness-files");
  assert.equal(await pdfText(new TextEncoder().encode("%PDF-1.4 tronqué"), 1000), "");
});
