/**
 * PDF fictifs pour les tests d'ingestion : une page avec une ligne de texte, une page sans
 * couche texte (comme un scan), ou un PDF chiffré dont le mot de passe d'ouverture est inconnu.
 */
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
