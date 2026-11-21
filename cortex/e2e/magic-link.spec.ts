import { test, expect } from "@playwright/test";
import { remoteBaseURL } from "./base-url";

// Le lien est capté par e2e/mail-receiver.ts, sur la machine du banc : une preview distante n'y écrit pas.
test.skip(!!remoteBaseURL, "Preview distante : pas de capture locale des e-mails.");

test("compte Cortex seul par lien magique capturé localement", async ({ page, request }) => {
  const email = `magic-${Date.now()}@e2e.cortex.test`;
  await page.goto("/login");
  await page.getByPlaceholder("ton@email.com").fill(email);
  await page.getByRole("button", { name: "Recevoir un lien de connexion" }).click();
  // DA de /login (pas la page NextAuth par défaut) : adresse affichée, pas de /api/auth/*.
  await expect(page).toHaveURL(`/verify-request?email=${encodeURIComponent(email)}`);
  await expect(page.getByText(email)).toBeVisible();
  let url = "";
  await expect.poll(async () => {
    const response = await request.get(`http://127.0.0.1:3211/latest?to=${encodeURIComponent(email)}`);
    if (response.ok()) url = String((await response.json()).url ?? "");
    return url;
  }).not.toBe("");
  await page.goto(url);
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByText(/Cortex/i).first()).toBeVisible();
});
