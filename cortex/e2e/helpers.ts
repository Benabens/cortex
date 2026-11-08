import { expect, type Page } from "@playwright/test";

export async function loginPersona(page: Page, name = "alice") {
  await page.goto(`/login?persona=${encodeURIComponent(`${name}@e2e.cortex.test`)}`);
  await page.getByTestId("e2e-login").click();
  await expect(page).not.toHaveURL(/\/login/);
}
