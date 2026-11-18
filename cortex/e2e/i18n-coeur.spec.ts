import { test, expect, type Page } from "@playwright/test";
import { loginPersona } from "./helpers";
import { frenchOnScreen, langViolations, minimalPdf } from "./i18n-helpers";

/**
 * Cœur de l'app en anglais : après la préparation d'un cours, chaque écran d'étude (programme,
 * révision, entraînement, faiblesses, recherche, examens) se lit sans un mot de français, et
 * la langue est déclarée partout où elle change (règles axe de WCAG 3.1.1 et 3.1.2).
 */

async function api<T>(page: Page, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  return page.evaluate(async ({ path, init }) => {
    const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    return { status: response.status, body: await response.json() };
  }, { path, init });
}

test("@i18n le cœur de l'app en anglais : écrans d'étude sans français, langue déclarée", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  // Seul le propriétaire prépare et génère sans crédits. Sa langue de compte passe avant le
  // navigateur et les autres parcours le voient en français : on la choisit ici, on la rend après.
  await loginPersona(page, "owner");
  expect((await api(page, "/api/account/locale", { method: "POST", body: JSON.stringify({ locale: "en" }) })).status).toBe(200);
  try {
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    await page.goto("/cours/nouveau");
    const courseName = `Calculus core ${Date.now()}`;
    await page.getByRole("textbox", { name: "Course name" }).fill(courseName);
    await page.getByRole("button", { name: "Create course" }).click();
    await expect(page).toHaveURL(/\/sources/);
    await page.locator('input[type="file"]').first().setInputFiles({ name: "calculus-final.pdf", mimeType: "application/pdf", buffer: minimalPdf() });
    await expect(page.getByText(/file ingested/i)).toBeVisible();
    await page.getByRole("button", { name: "Prepare course" }).click();
    await expect(page.getByText(/Course prepared/i)).toBeVisible();

    const catalog = await api<{ courses: Array<{ id: string; name: string }> }>(page, "/api/courses");
    const course = catalog.body.courses.find((item) => item.name === courseName)?.id; expect(course).toBeTruthy();
    const exam = await api<{ ok: boolean }>(page, `/api/exams/generate?dry=1&course=${encodeURIComponent(course!)}`, { method: "POST", body: "{}" });
    expect(exam.status).toBe(200);

    for (const path of ["/", "/programme", "/revision", "/entrainement", "/faiblesses", "/recherche", "/examens"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page.locator("main")).toBeVisible();
      expect(await frenchOnScreen(page), path).toEqual([]);
      expect(await langViolations(page), path).toEqual([]);
    }
  } finally {
    await api(page, "/api/account/locale", { method: "POST", body: JSON.stringify({ locale: "fr" }) });
    await context.close();
  }
});
