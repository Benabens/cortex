import { test, expect } from "@playwright/test";
import crypto from "node:crypto";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { baseURL, remoteBaseURL } from "./base-url";
import { REVIEW_E2E_EMAIL, REVIEW_E2E_PASSWORD } from "./review-credentials";

/**
 * Parcours du relecteur d'annuaire : le client MCP l'envoie sur /oauth/authorize,
 * Cortex le renvoie sur /login, il se connecte par « Accès relecteur » (e-mail +
 * mot de passe), revient au consentement, autorise, et le jeton ouvre /mcp au nom
 * du compte démo, qui n'est pas propriétaire (il voit le devis, comme un client).
 */
const origin = new URL(baseURL).origin;
const callback = `${origin}/e2e-oauth-callback`;

// Une preview de PR n'a pas les variables de la connexion relecteur.
test.skip(!!remoteBaseURL, "serveur local seulement");

test("relecteur : /oauth/authorize → /login → mot de passe → consentement → MCP", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/login");
  const registration = await page.evaluate(async (callback) => {
    const response = await fetch("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "E2E relecteur", redirect_uris: [callback], token_endpoint_auth_method: "none" }) });
    return { status: response.status, body: await response.json() };
  }, callback);
  expect(registration.status).toBe(201);
  const clientId = String(registration.body.client_id);
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: callback, code_challenge: challenge, code_challenge_method: "S256", resource: `${origin}/mcp`, scope: "cortex.read cortex.write cortex.generate", state: "relecteur" });

  // Sans session : le consentement renvoie sur /login, en gardant le retour.
  await page.goto(`/oauth/authorize?${params}`);
  await expect(page).toHaveURL(/\/login\?callbackUrl=/);
  await expect(page.getByTestId("review-login")).toHaveCount(0);
  await page.getByRole("button", { name: "Accès relecteur" }).click();

  // Faute de frappe : message, on reste sur la page avec le même retour.
  await page.getByLabel("E-mail").fill(REVIEW_E2E_EMAIL);
  await page.getByLabel("Mot de passe").fill("pas-le-bon-mot-de-passe");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByTestId("review-login").getByRole("alert")).toContainText("E-mail ou mot de passe incorrect");
  await expect(page).toHaveURL(/\/login\?callbackUrl=/);

  await page.getByLabel("Mot de passe").fill(REVIEW_E2E_PASSWORD);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page).toHaveURL(/\/oauth\/authorize\?/);
  await expect(page.getByRole("button", { name: "Autoriser" })).toBeVisible();
  await expect(page.getByText(REVIEW_E2E_EMAIL)).toBeVisible();

  const ticket = await page.locator('input[name="ticket"]').inputValue();
  const decision = await page.request.post("/oauth/authorize/decision", {
    form: { ticket, decision: "approve", generate: "on", write: "on" },
    headers: { origin }, maxRedirects: 0,
  });
  expect(decision.status()).toBe(303);
  const back = new URL(decision.headers().location);
  expect(back.searchParams.get("state")).toBe("relecteur");
  const code = back.searchParams.get("code")!;
  expect(code).toMatch(/^cx_code_/);
  const token = await page.evaluate(async (fields) => {
    const response = await fetch("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
    return { status: response.status, body: await response.json() };
  }, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: callback, resource: `${origin}/mcp` });
  expect(token.status, JSON.stringify(token.body)).toBe(200);

  const client = new Client({ name: "e2e-relecteur", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: { token: async () => String(token.body.access_token) } });
  await client.connect(transport);
  const status = await client.callTool({ name: "get_account_status", arguments: {} }) as CallToolResult;
  expect(status.isError ?? false, JSON.stringify(status.content)).toBe(false);
  // Pas propriétaire : il paie en crédits, comme un client (devis puis confirmation).
  const account = status.structuredContent as { owner_mode: boolean; credits: { balance: number } | null };
  expect(account.owner_mode).toBe(false);
  expect(account.credits).not.toBeNull();
  await transport.close();
});
