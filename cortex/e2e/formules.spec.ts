import { test, expect, type Page } from "@playwright/test";
import { loginPersona } from "./helpers";
import { BLOCKS_EXAM, BLOCKS_GRADE, BLOCKS_ID, CHECK_RESULT, QCM_EXAM, QCM_GRADE, QCM_ID } from "./formules-fixtures";

/**
 * FORMULES À L'ÉCRAN (demandé le 23/11/2026) : l'étudiant lisait « Soit $x_{t+1} = 2x_t$, que vaut
 * $\frac{x_3}{x_1}$ ? ». Examens fictifs servis par interception (e2e/formules-fixtures.ts) ; le
 * rendu, lui, est le vrai : POST /api/math compose côté serveur. Aucune source brute ne doit rester
 * visible, chaque formule porte son MathML, et rien ne déborde à 390 px.
 */

/** Le texte que l'œil voit dans la page (le MathML caché aux yeux et l'annotation TeX exclus). */
async function visibleText(page: Page): Promise<string> {
  return page.locator("main").evaluate((el) => (el as HTMLElement).innerText);
}

async function expectNoRawFormula(page: Page) {
  await expect(page.locator(".katex").first()).toBeVisible();
  const text = await visibleText(page);
  expect(text).not.toMatch(/\$/);
  expect(text).not.toMatch(/\\(?:frac|sum|sqrt|le|\(|\[)/);
  expect(text).not.toMatch(/x_\{t\+1\}/);
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "la page défile horizontalement").toBeLessThanOrEqual(1);
}

async function newCourse(page: Page): Promise<string> {
  await loginPersona(page, `formules-${Date.now()}`);
  await page.goto("/cours/nouveau");
  const name = `Analyse ${Date.now()}`;
  await page.getByRole("textbox", { name: "Nom du cours" }).fill(name);
  await page.getByRole("button", { name: "Créer le cours" }).click();
  await expect(page).toHaveURL(/\/sources/);
  const course = await page.evaluate(async (n) => {
    const { courses } = await (await fetch("/api/courses")).json() as { courses: Array<{ id: string; name: string }> };
    return courses.find((c) => c.name === n)?.id ?? null;
  }, name);
  expect(course).toBeTruthy();
  return course!;
}

test("QCM : énoncés, options et corrigé mis en forme, MathML compris, sans débordement mobile", async ({ page }) => {
  const course = await newCourse(page);
  await page.route(`**/api/qcm/${QCM_ID}/grade*`, (r) => r.fulfill({ json: QCM_GRADE }));
  await page.route(`**/api/qcm/${QCM_ID}?*`, (r) => r.fulfill({ json: QCM_EXAM }));
  await page.goto(`/mock/${QCM_ID}?course=${course}`);
  await expect(page.getByText("Soit la suite définie par")).toBeVisible();
  await expect(page.locator(".katex")).toHaveCount(3 + 4 + 1 + 3);
  await expectNoRawFormula(page);
  // lecteurs d'écran : le MathML est là, le rendu visuel leur est caché
  await expect(page.locator(".katex math").first()).toBeAttached();
  await expect(page.locator(".katex-html").first()).toHaveAttribute("aria-hidden", "true");

  // une réponse par question (boutons d'option, aria-pressed), puis la correction
  const options = page.locator("button[aria-pressed]");
  await options.nth(0).click();
  await options.nth(4).click();
  await page.getByRole("button", { name: "Corriger mon examen" }).click();
  await expect(page.getByText("Pourquoi :").first()).toBeVisible();
  await expect(page.getByText("Confond")).toBeVisible();
  await expectNoRawFormula(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalScroll(page);
});

test("question composée et retour de correction : \\frac, \\sum, indices et formule détachée", async ({ page }) => {
  const course = await newCourse(page);
  await page.route(`**/api/qcm/${BLOCKS_ID}/grade*`, (r) => r.fulfill({ json: BLOCKS_GRADE }));
  await page.route(`**/api/qcm/${BLOCKS_ID}?*`, (r) => r.fulfill({ json: BLOCKS_EXAM }));
  await page.route("**/api/check-solution*", (r) => r.fulfill({ json: { result: CHECK_RESULT } }));
  // compte sans crédit : la vérification est permise quand la lecture du quota échoue (useLaunchUsage)
  await page.route("**/api/usage*", (r) => r.abort());
  await page.goto(`/mock/${BLOCKS_ID}?course=${course}`);
  await expect(page.getByText("On étudie la somme partielle")).toBeVisible();
  await expectNoRawFormula(page);
  const display = page.locator(".math-display").first();
  await expect(display).toHaveAttribute("tabindex", "0");

  await page.locator("button[aria-pressed]").first().click();
  await page.getByRole("button", { name: "Corriger mon examen" }).click();
  await expect(page.getByText("Barème", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Ta réponse" }).fill("Par récurrence sur n.");
  await page.getByRole("button", { name: /Vérifier ma réponse/ }).click();
  await expect(page.getByText("L'idée de la récurrence est juste")).toBeVisible();
  await expectNoRawFormula(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalScroll(page);
  // la formule longue défile dans son propre conteneur
  expect(await display.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});
