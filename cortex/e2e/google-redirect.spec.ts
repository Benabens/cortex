import { test } from "@playwright/test";
import { googleBaseURL as base } from "./base-url";
import { expectGoogleOAuthRedirect } from "./helpers";

// Vérification fiable du bouton Google, sans se connecter (cf. expectGoogleOAuthRedirect).
// Ce test casse si le client OAuth, l'URL de retour ou les scopes changent.

test("@googleredirect le bouton Google redirige vers Google avec le bon client", async ({ page }) => {
  await page.goto("/login");
  await expectGoogleOAuthRedirect(page, new URL(base).origin);
});
