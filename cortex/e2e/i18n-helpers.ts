import type { Page } from "@playwright/test";
import { looksFrench } from "../tests/helpers/i18n-scan";

/** Petit PDF valide d'une page, texte anglais (fixture fictive). */
export function minimalPdf(): Buffer {
  const stream = "BT /F1 12 Tf 30 100 Td (Calculus past exam) Tj ET\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let text = "%PDF-1.4\n", offset = text.length; const offsets = [0];
  for (const object of objects) { offsets.push(offset); text += object; offset += object.length; }
  const xref = offset;
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n `).join("\n")}\n`;
  text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

/**
 * Texte visible et noms accessibles de la page qui ressemblent à du français, ligne par ligne.
 * Ne comptent pas : le sélecteur de langue (« Français ») et le contenu déclaré dans une autre
 * langue que celle de la page (`lang` du cours, WCAG 3.1.2), qui n'est pas de l'interface.
 */
export async function frenchOnScreen(page: Page): Promise<string[]> {
  const lines = await page.evaluate(() => {
    const pageLang = document.documentElement.lang;
    const inPageLang = (el: Element | null) => (el?.closest("[lang]")?.getAttribute("lang") ?? pageLang) === pageLang;
    const visible = (el: Element | null) => !!el && (el as HTMLElement).checkVisibility?.() !== false;
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName) || !visible(el) || !inPageLang(el)) continue;
      out.push(...(n.textContent ?? "").split("\n"));
    }
    for (const el of Array.from(document.querySelectorAll("[aria-label],[placeholder],[title],[alt]"))) {
      if (!inPageLang(el)) continue;
      for (const a of ["aria-label", "placeholder", "title", "alt"]) { const v = el.getAttribute(a); if (v) out.push(v); }
    }
    return out;
  });
  return lines.map((l) => l.trim()).filter((l) => l && l !== "Français" && looksFrench(l));
}

/** Règles axe de la langue (WCAG 3.1.1 et 3.1.2) : `lang` présent, valide, jamais vide. */
export async function langViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: Document, o: object) => Promise<{ violations: { id: string; nodes: { html: string }[] }[] }> } }).axe;
    const r = await axe.run(document, { runOnly: { type: "rule", values: ["html-has-lang", "html-lang-valid", "valid-lang"] } });
    return r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 120)}`));
  });
}
