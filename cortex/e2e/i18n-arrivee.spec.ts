import { test, expect } from "@playwright/test";
import { loginPersona } from "./helpers";
import { frenchOnScreen, minimalPdf } from "./i18n-helpers";

/**
 * Parcours d'arrivée en anglais : un étudiant au navigateur anglais, sans compte, se connecte,
 * crée son cours et importe une annale sans lire un mot de français.
 */

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
