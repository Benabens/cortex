import { test, expect } from "@playwright/test";
import { loginPersona } from "./helpers";
import { frenchOnScreen, langViolations } from "./i18n-helpers";

/**
 * Compte et argent en anglais : un étudiant au navigateur anglais lit son compte, ses crédits,
 * son usage et la page des assistants sans français (hors versions françaises qui font foi,
 * déclarées lang="fr"), et la suppression accepte DELETE.
 */
test("@i18n compte, crédits et assistants en anglais, sans français hors version qui fait foi", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  await loginPersona(page, `compte-${Date.now()}`);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  for (const path of ["/compte", "/compte/assistants"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("main")).toBeVisible();
    expect(await frenchOnScreen(page), path).toEqual([]);
    expect(await langViolations(page), path).toEqual([]);
  }

  await page.goto("/compte");
  await page.getByRole("button", { name: "Delete my account" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(await frenchOnScreen(page)).toEqual([]);
  const confirm = dialog.getByRole("button", { name: "Delete permanently" });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("textbox").fill("DELETE");
  await expect(confirm).toBeEnabled();
  await context.close();
});
