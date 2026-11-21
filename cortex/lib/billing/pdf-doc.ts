/**
 * PDF MINIMAL d'une page (A4), sans dépendance : textes en Helvetica / Helvetica-Bold
 * (polices standard, non embarquées), filets, aplats et polygones. Assez pour une
 * facture ; rien de plus. Encodage WinAnsi : les accents du français et « € »
 * passent ; un caractère hors de cette table perd son accent, sinon devient « ? ».
 */

export type Rgb = readonly [number, number, number];
type Font = "regular" | "bold";

export const A4 = { width: 595.28, height: 841.89 } as const;

// Chasses Adobe (1/1000 d'em) des caractères ASCII 32 à 126.
const W_REGULAR = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// Windows-1252, plage 0x80–0x9F.
const CP1252: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e,
  "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};
// Espaces et signes typographiques sans équivalent WinAnsi.
const SUBSTITUTE: Record<string, string> = { " ": " ", " ": " ", " ": " ", "−": "-", "‑": "-" };

/** Octets WinAnsi d'une chaîne (un par caractère). */
export function winAnsi(s: string): number[] {
  const out: number[] = [];
  for (const raw of s) {
    const ch = SUBSTITUTE[raw] ?? raw;
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code <= 0x7e) out.push(code);
    else if (code >= 0xa0 && code <= 0xff) out.push(code);
    else if (CP1252[ch] !== undefined) out.push(CP1252[ch]);
    else {
      const base = ch.normalize("NFD").replace(/\p{M}/gu, "");
      const b = base.codePointAt(0) ?? 0;
      out.push(base.length === 1 && b >= 0x20 && b <= 0x7e ? b : 0x3f);
    }
  }
  return out;
}

function charWidth(byte: number, font: Font): number {
  const table = font === "bold" ? W_BOLD : W_REGULAR;
  if (byte >= 0x20 && byte <= 0x7e) return table[byte - 0x20];
  // Lettres accentuées : la chasse de leur lettre de base, à peu de chose près.
  const ch = new TextDecoder("windows-1252").decode(new Uint8Array([byte]));
  const base = ch.normalize("NFD").replace(/\p{M}/gu, "").codePointAt(0) ?? 0;
  return base >= 0x20 && base <= 0x7e ? table[base - 0x20] : 556;
}

/** Largeur d'un texte en points. */
export function textWidth(s: string, size: number, font: Font = "regular"): number {
  return winAnsi(s).reduce((w, b) => w + charWidth(b, font), 0) * size / 1000;
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();
const rgb = (c: Rgb) => c.map((v) => num(v / 255)).join(" ");
function pdfString(s: string): string {
  return "(" + winAnsi(s).map((b) => (b === 0x28 || b === 0x29 || b === 0x5c ? "\\" + String.fromCharCode(b) : b < 0x20 || b > 0x7e ? "\\" + b.toString(8).padStart(3, "0") : String.fromCharCode(b))).join("") + ")";
}

/** Une page, coordonnées en points depuis le HAUT à gauche (y vers le bas, comme l'écran). */
export class PdfPage {
  private ops: string[] = [];

  text(x: number, y: number, s: string, o: { size?: number; font?: Font; color?: Rgb; align?: "left" | "right" } = {}): void {
    const size = o.size ?? 10;
    const font = o.font ?? "regular";
    const left = o.align === "right" ? x - textWidth(s, size, font) : x;
    this.ops.push(`BT /${font === "bold" ? "F2" : "F1"} ${num(size)} Tf ${rgb(o.color ?? [0, 0, 0])} rg ${num(left)} ${num(A4.height - y)} Td ${pdfString(s)} Tj ET`);
  }

  line(x1: number, y1: number, x2: number, y2: number, color: Rgb, width = 0.75): void {
    this.ops.push(`${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(A4.height - y1)} m ${num(x2)} ${num(A4.height - y2)} l S`);
  }

  rect(x: number, y: number, w: number, h: number, color: Rgb): void {
    this.ops.push(`${rgb(color)} rg ${num(x)} ${num(A4.height - y - h)} ${num(w)} ${num(h)} re f`);
  }

  /** Polygone plein, points en coordonnées de page. */
  polygon(points: Array<[number, number]>, color: Rgb): void {
    const [first, ...rest] = points;
    this.ops.push(`${rgb(color)} rg ${num(first[0])} ${num(A4.height - first[1])} m ${rest.map(([x, y]) => `${num(x)} ${num(A4.height - y)} l`).join(" ")} h f`);
  }

  circle(cx: number, cy: number, r: number, color: Rgb): void {
    const k = 0.5523 * r;
    const y = A4.height - cy;
    this.ops.push(`${rgb(color)} rg ${num(cx + r)} ${num(y)} m `
      + `${num(cx + r)} ${num(y + k)} ${num(cx + k)} ${num(y + r)} ${num(cx)} ${num(y + r)} c `
      + `${num(cx - k)} ${num(y + r)} ${num(cx - r)} ${num(y + k)} ${num(cx - r)} ${num(y)} c `
      + `${num(cx - r)} ${num(y - k)} ${num(cx - k)} ${num(y - r)} ${num(cx)} ${num(y - r)} c `
      + `${num(cx + k)} ${num(y - r)} ${num(cx + r)} ${num(y - k)} ${num(cx + r)} ${num(y)} c f`);
  }

  /** Le fichier PDF complet. `title` : métadonnée affichée par les lecteurs. */
  toPdf(meta: { title: string; author: string }): Buffer {
    const content = this.ops.join("\n");
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
      `<< /Title ${pdfString(meta.title)} /Author ${pdfString(meta.author)} /Producer (Cortex) >>`,
    ];
    let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, "latin1"));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
}
