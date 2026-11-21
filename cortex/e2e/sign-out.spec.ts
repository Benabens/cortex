import { test, expect } from "@playwright/test";
import { loginPersona } from "./helpers";

/**
 * Jusqu'ici, aucun bouton "Se déconnecter" dans l'app : seule /api/auth/signout (page
 * NextAuth par défaut, en anglais et sans style) le permettait. Les deux chemins ajoutés —
 * /compte et le menu de compte du Topbar — doivent vraiment couper la session, pas
 * seulement naviguer vers /login (un second accès à une page protégée doit y renvoyer).
 */

test("se déconnecter depuis /compte coupe vraiment la session", async ({ page }) => {
  await loginPersona(page, "signout-compte");
  await page.goto("/compte");
  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/compte");
  await expect(page).toHaveURL(/\/login/);
});

test("se déconnecter depuis le menu de compte du Topbar coupe vraiment la session", async ({ page }) => {
  await loginPersona(page, "signout-menu");
  await page.getByRole("button", { name: "Mon compte" }).click();
  const panel = page.locator("#account-menu-panel");
  await expect(panel.getByRole("link", { name: "Mon compte" })).toBeVisible();
  await panel.getByRole("button", { name: "Se déconnecter" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/compte");
  await expect(page).toHaveURL(/\/login/);
});
