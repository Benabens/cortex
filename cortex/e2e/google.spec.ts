import { test, expect } from "@playwright/test";
import { generateSync } from "otplib";
import fs from "node:fs";

const authFile = "e2e/.auth/google.json";
const googleBaseURL = process.env.E2E_GOOGLE_BASE_URL ?? "https://app.cortexexam.com";
const configured = !!(process.env.E2E_GOOGLE_EMAIL && process.env.E2E_GOOGLE_PASSWORD && process.env.E2E_GOOGLE_TOTP_SECRET);
test.describe.configure({ mode: "serial" });

test("@google connexion Google réelle sauvegarde la session", async ({ page }) => {
  test.skip(!configured, "Identifiants Google ou TOTP absents de .env.e2e.local (lancer scripts/qa-setup.sh).");
  await page.goto("/login"); await page.getByRole("button", { name: "Continuer avec Google" }).click();
  if (/challenge\/recaptcha|\/sorry\//.test(page.url())) throw new Error("Google a demandé un captcha : aucun contournement automatique n'est tenté.");
  await page.locator('input[type="email"]').fill(process.env.E2E_GOOGLE_EMAIL!); await page.getByRole("button", { name: /Suivant|Next/ }).click();
  await page.locator('input[type="password"]').fill(process.env.E2E_GOOGLE_PASSWORD!); await page.getByRole("button", { name: /Suivant|Next/ }).click();
  const totp = page.locator('input[type="tel"]');
  if (await totp.isVisible({ timeout: 10_000 }).catch(() => false)) { await totp.fill(generateSync({ secret: process.env.E2E_GOOGLE_TOTP_SECRET! })); await page.getByRole("button", { name: /Suivant|Next/ }).click(); }
  if (/challenge\/recaptcha|\/sorry\//.test(page.url())) throw new Error("Google a demandé un captcha : échec clair, aucun contournement.");
  await page.waitForURL((u) => u.origin === new URL(googleBaseURL).origin && !u.pathname.startsWith("/login"), { timeout: 30_000 });
  fs.mkdirSync("e2e/.auth", { recursive: true }); await page.context().storageState({ path: authFile });
});

test("@google la session sauvegardée est réutilisable", async ({ browser }) => {
  test.skip(!configured || !fs.existsSync(authFile), "Session Google non disponible (connexion précédente sautée ou bloquée). ");
  const context = await browser.newContext({ storageState: authFile }); const page = await context.newPage();
  await page.goto("/"); await expect(page).not.toHaveURL(/\/login/); await context.close();
});
