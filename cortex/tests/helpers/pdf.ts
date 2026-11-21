/**
 * PDF fictifs pour les tests d'ingestion : une page avec une ligne de texte, une page sans
 * couche texte (comme un scan), ou un PDF chiffré dont le mot de passe d'ouverture est inconnu.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { findPdftoppm } from "../../lib/pdftoppm";

function assemble(objs: string[], trailerExtra = ""): Buffer {
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function pageObjects(text: string | null): string[] {
  const content = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
  return [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
}

/** Une page ; `null` : aucune couche texte (scan). */
export function textPdf(text: string | null): Buffer {
  return assemble(pageObjects(text));
}

/** Commence comme un PDF mais ne s'ouvre pas (fichier tronqué ou abîmé). */
export function corruptPdf(): Buffer {
  return Buffer.from("%PDF-1.4\nceci n'est pas un pdf\n", "latin1");
}

/** Chiffré (gestionnaire standard, RC4 40 bits) : le mot de passe vide ne l'ouvre pas. */
export function encryptedPdf(): Buffer {
  const objs = pageObjects("Sujet confidentiel");
  const hex = (c: string) => `<${c.repeat(64)}>`;
  objs.push(`<< /Filter /Standard /V 1 /R 2 /O ${hex("a")} /U ${hex("b")} /P -4 >>`);
  return assemble(objs, `/Encrypt ${objs.length} 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] `);
}

/**
 * Un SCAN fictif : chaque page est d'abord écrite en texte (Helvetica 20 pt), rendue en image
 * grise par pdftoppm, puis remise seule dans un PDF, sans couche texte, comme le PDF d'un
 * scanner. `null` : une page blanche scannée. Lève sans pdftoppm.
 */
export function scannedPdf(pages: (string[] | null)[], opts: { dpi?: number } = {}): Buffer {
  return imagePdf(pages.map((lines) => scanImage(lines, opts)));
}

type GrayImage = { width: number; height: number; pixels: Buffer };

/** L'image grise d'une page de texte scannée (Helvetica 20 pt rendu par pdftoppm). Lève sans pdftoppm. */
export function scanImage(lines: string[] | null, opts: { dpi?: number } = {}): GrayImage {
  const bin = findPdftoppm();
  if (!bin) throw new Error("pdftoppm absent : impossible de fabriquer un scan de test");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-scan-"));
  try {
    const content = lines?.length ? `BT /F1 20 Tf 72 700 Td 28 TL ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET` : "";
    const src = path.join(dir, "page.pdf");
    fs.writeFileSync(src, assemble([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]));
    execFileSync(bin, ["-gray", "-r", String(opts.dpi ?? 150), "-singlefile", src, path.join(dir, "page")]);
    return readPgm(fs.readFileSync(path.join(dir, "page.pgm")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Un PDF de pages US Letter : une image grise seule (sans couche texte, comme un scanner), ou
 * `{ text }` pour une page de texte ordinaire.
 */
export function imagePdf(pages: (GrayImage | { text: string })[]): Buffer {
  const objs: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, k) => `${3 + 3 * k} 0 R`).join(" ")}] /Count ${pages.length} >>`];
  pages.forEach((p, k) => {
    const page = 3 + 3 * k;
    if ("text" in p) {
      const content = `BT /F1 12 Tf 72 720 Td (${p.text}) Tj ET`;
      objs.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${page + 1} 0 R /Resources << /Font << /F1 ${page + 2} 0 R >> >> >>`,
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      );
      return;
    }
    const draw = "q 612 0 0 792 0 0 cm /Im1 Do Q";
    const data = zlib.deflateSync(p.pixels).toString("latin1");
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${page + 1} 0 R /Resources << /XObject << /Im1 ${page + 2} 0 R >> >> >>`,
      `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n${data}\nendstream`,
    );
  });
  return assemble(objs);
}

/** Une image grise de bruit aléatoire (graine fixe) : un scan qui ne contient aucun texte. */
export function noiseImage(width = 1275, height = 1650, seed = 7): GrayImage {
  const pixels = Buffer.alloc(width * height);
  let s = seed;
  for (let i = 0; i < pixels.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    pixels[i] = s & 0xff;
  }
  return { width, height, pixels };
}

function readPgm(buf: Buffer): GrayImage {
  // En-tête « P5\n<largeur> <hauteur>\n255\n », puis un octet par pixel.
  const header = buf.subarray(0, 64).toString("latin1").match(/^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/);
  if (!header) throw new Error("PGM attendu");
  const [, w, h] = header.map(Number);
  return { width: w, height: h, pixels: buf.subarray(header[0].length, header[0].length + w * h) };
}
