import { expect, type Page } from "@playwright/test";

export async function loginPersona(page: Page, name = "alice") {
  // Preview de PR : clé persona (secret GitHub E2E_PERSONA_KEY) ; rien en local.
  const key = process.env.E2E_PERSONA_KEY ? `&persona_key=${encodeURIComponent(process.env.E2E_PERSONA_KEY)}` : "";
  await page.goto(`/login?persona=${encodeURIComponent(`${name}@e2e.cortex.test`)}${key}`);
  await page.getByTestId("e2e-login").click();
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * Le bouton Google de /login (page déjà ouverte) redirige vers Google avec le
 * bon client, la bonne URL de retour et les bons scopes — sans se connecter :
 * Google bloque les connexions automatisées depuis les serveurs de CI, mais la
 * redirection est entièrement sous notre contrôle, et c'est elle qui casse en pratique.
 */
export async function expectGoogleOAuthRedirect(page: Page, origin: string) {
  const toGoogle = page.waitForRequest((r) => r.url().startsWith("https://accounts.google.com/"), { timeout: 30_000 });
  await page.getByRole("button", { name: "Continuer avec Google" }).click();
  const url = new URL((await toGoogle).url());
  // Le premier hop peut être /o/oauth2/v2/auth ou /v3/signin/... avec les paramètres imbriqués.
  const params = url.searchParams.get("client_id") ? url.searchParams : new URL(decodeURIComponent(url.searchParams.get("continue") ?? url.href)).searchParams;
  expect(params.get("client_id") ?? "", "client_id OAuth présent").toMatch(/\.apps\.googleusercontent\.com$/);
  expect(params.get("redirect_uri"), "URL de retour = vrai site").toBe(`${origin}/api/auth/callback/google`);
  expect(params.get("response_type")).toBe("code");
  expect(params.get("scope") ?? "").toContain("email");
}
