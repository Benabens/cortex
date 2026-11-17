import { test, expect, type Browser } from "@playwright/test";
import { loginPersona } from "./helpers";

/**
 * Langue de l'interface : le navigateur décide tant que personne n'a choisi, le sélecteur
 * de /login pose un cookie, et le choix fait dans /compte suit le compte sur un autre
 * appareil (langue du navigateur différente).
 */

async function htmlLang(browser: Browser, locale: string, path = "/login"): Promise<string | null> {
  const context = await browser.newContext({ locale });
  const page = await context.newPage();
  await page.goto(path);
  const lang = await page.locator("html").getAttribute("lang");
  await context.close();
  return lang;
}

test("Accept-Language : anglais → <html lang=\"en\">, français → fr, autre → anglais", async ({ browser }) => {
  expect(await htmlLang(browser, "en-US")).toBe("en");
  expect(await htmlLang(browser, "fr-CH")).toBe("fr");
  expect(await htmlLang(browser, "de-DE")).toBe("en");
});

test("sélecteur de /login : le choix survit au rechargement, avant toute connexion", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  await page.goto("/login");
  const french = page.getByRole("radio", { name: "Français" });
  await expect(french).toHaveAttribute("lang", "fr");
  await french.click();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.getByRole("radio", { name: "Français" })).toHaveAttribute("aria-checked", "true");
  await context.close();
});

test("langue choisie dans /compte : elle suit le compte sur un navigateur anglais", async ({ browser }) => {
  const persona = `i18n-${Date.now()}`;
  const first = await browser.newContext({ locale: "fr-FR" });
  const page = await first.newPage();
  await loginPersona(page, persona);
  await page.goto("/compte");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await page.getByRole("radio", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByRole("radio", { name: "Français" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await first.close();

  // Autre appareil, navigateur anglais, aucun cookie : la langue du compte prime.
  const second = await browser.newContext({ locale: "en-US" });
  const other = await second.newPage();
  await loginPersona(other, persona);
  await other.goto("/compte");
  await expect(other.locator("html")).toHaveAttribute("lang", "fr");
  await second.close();
});
