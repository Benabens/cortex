/**
 * AUDIT PRÉ-LANCEMENT DU 14/11/2026, 🟠 18 : pdftoppm tournait sans délai ni limite de taille
 * (execFileSync synchrone, lib/course-vision et lib/exam-index). Un PDF piégé (page géante,
 * boucle) faisait manquer de mémoire le seul conteneur ou bloquait le worker.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pdftoppm-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** PDF minimal d'une page de `size` × `size` points (14 400 pt = 5 m : la plus grande permise). */
function pdfWithPage(size: number): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size} ${size}] >>`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const pngSize = (f: string) => { const b = fs.readFileSync(f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };

test("une page géante est rendue plafonnée, pas à sa taille réelle", async (t) => {
  const { findPdftoppm, renderPdfPages, PAGE_MAX_PX } = await import("../lib/pdftoppm");
  const bin = findPdftoppm();
  if (!bin) return t.skip("pdftoppm absent");
  const pdf = path.join(tmp, "geante.pdf");
  fs.writeFileSync(pdf, pdfWithPage(14_400)); // sans plafond, à 120 dpi : 24 000 × 24 000 px
  renderPdfPages(bin, pdf, path.join(tmp, "geante"), { lastPage: 1 });
  const png = fs.readdirSync(tmp).find((f) => f.startsWith("geante-") && f.endsWith(".png"));
  assert.ok(png, "une image doit être produite");
  const { w, h } = pngSize(path.join(tmp, png));
  assert.ok(Math.max(w, h) <= PAGE_MAX_PX, `${w} × ${h}`);
  assert.ok(PAGE_MAX_PX <= 2000);
});

test("un rendu qui ne rend pas la main est tué au délai", async () => {
  const { renderPdfPages } = await import("../lib/pdftoppm");
  const fake = path.join(tmp, "pdftoppm-bloque");
  fs.writeFileSync(fake, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
  const t0 = Date.now();
  assert.throws(() => renderPdfPages(fake, path.join(tmp, "x.pdf"), path.join(tmp, "x"), { lastPage: 1, timeoutMs: 300 }));
  assert.ok(Date.now() - t0 < 5_000, `tué après ${Date.now() - t0} ms`);
});
