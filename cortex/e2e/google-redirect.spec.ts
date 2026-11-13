import { test, expect } from "@playwright/test";

// Vérification fiable du bouton Google, sans se connecter : Google bloque les
// connexions automatisées depuis les serveurs de CI, mais la redirection, elle,
// est entièrement sous notre contrôle. Ce test casse si le client OAuth, l'URL
// de retour ou les scopes changent — ce qui casse vraiment en pratique.
const base = process.env.E2E_GOOGLE_BASE_URL ?? "https://app.cortexexam.com";

test("@googleredirect le bouton Google redirige vers Google avec le bon client", async ({ page }) => {
  await page.goto("/login");
  const toGoogle = page.waitForRequest((r) => r.url().startsWith("https://accounts.google.com/"), { timeout: 30_000 });
  await page.getByRole("button", { name: "Continuer avec Google" }).click();
  const url = new URL((await toGoogle).url());
  // Le premier hop peut être /o/oauth2/v2/auth ou /v3/signin/... avec les paramètres imbriqués.
  const params = url.searchParams.get("client_id") ? url.searchParams : new URL(decodeURIComponent(url.searchParams.get("continue") ?? url.href)).searchParams;
  expect(params.get("client_id") ?? "", "client_id OAuth présent").toMatch(/\.apps\.googleusercontent\.com$/);
  expect(params.get("redirect_uri"), "URL de retour = vrai site").toBe(`${new URL(base).origin}/api/auth/callback/google`);
  expect(params.get("response_type")).toBe("code");
  expect(params.get("scope") ?? "").toContain("email");
});
