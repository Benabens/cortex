import { test, expect, type Page } from "@playwright/test";
import { loginPersona } from "./helpers";
import { looksFrench } from "../tests/helpers/i18n-scan";

/**
 * Parcours d'arrivée en anglais : un étudiant au navigateur anglais, sans compte, se connecte,
 * crée son cours et importe une annale sans lire un mot de français.
 */

function minimalPdf(): Buffer {
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

/** Texte visible et noms accessibles de la page, ligne par ligne, sans le sélecteur de langue. */
async function frenchOnScreen(page: Page): Promise<string[]> {
  const lines = await page.evaluate(() => {
    const out = document.body.innerText.split("\n");
    for (const el of Array.from(document.querySelectorAll("[aria-label],[placeholder],[title],[alt]"))) {
      for (const a of ["aria-label", "placeholder", "title", "alt"]) { const v = el.getAttribute(a); if (v) out.push(v); }
    }
    return out;
  });
  return lines.map((l) => l.trim()).filter((l) => l && l !== "Français" && looksFrench(l));
}

test("@i18n un étudiant anglophone crée un cours et importe une annale, tout en anglais", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();

  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(await frenchOnScreen(page)).toEqual([]);

  await loginPersona(page, `arrivee-${Date.now()}`);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(await frenchOnScreen(page)).toEqual([]);

  await page.goto("/cours/nouveau");
  expect(await frenchOnScreen(page)).toEqual([]);
  await page.getByRole("textbox", { name: "Course name" }).fill(`Calculus ${Date.now()}`);
  await page.getByRole("button", { name: "Create course" }).click();
  await expect(page).toHaveURL(/\/sources/);
  expect(await frenchOnScreen(page)).toEqual([]);

  await page.locator('input[type="file"]').first().setInputFiles({ name: "calculus-final.pdf", mimeType: "application/pdf", buffer: minimalPdf() });
  await expect(page.getByText(/file ingested/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare course" })).toBeVisible();
  expect(await frenchOnScreen(page)).toEqual([]);
  await context.close();
});
