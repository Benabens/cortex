import { test, expect } from "@playwright/test";
import { smokeBaseURL as base } from "./base-url";
import { expectGoogleOAuthRedirect } from "./helpers";

/**
 * SMOKE APRÈS DÉPLOIEMENT (.github/workflows/post-deploy.yml) contre la vraie
 * prod. LECTURE SEULE : aucun compte, aucune session, aucune écriture en base.
 * Un échec déclenche le rollback : chaque test vise ce qu'un déploiement de
 * l'app casse vraiment (démarrage, rendu, auth, connecteur MCP), jamais un
 * service tiers que le rollback ne réparerait pas (la vitrine Vercel, par exemple).
 */
const origin = new URL(base).origin;
const expectedSha = process.env.E2E_EXPECTED_SHA;

test("@smoke santé : base joignable, moteur prêt, commit attendu en ligne", async ({ request }) => {
  const r = await request.get("/api/health");
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.status).toBe("ok");
  expect(body.checks.db).toBe(true);
  expect(body.checks.llm, "moteur LLM configuré").toBe(true);
  expect(body.checks.latex, "LaTeX présent dans l'image").toBe(true);
  if (expectedSha) expect(body.commit, "commit servi").toBe(expectedSha);
});

test("@smoke visiteur anonyme : la racine mène à /login, qui s'affiche sans erreur JavaScript", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page).toHaveTitle(/cortex/i);
  await expect(page.getByRole("button", { name: "Continuer avec Google" })).toBeVisible();
  expect(errors, "erreurs JavaScript sur /login").toEqual([]);
});

test("@smoke bouton Google → bonne redirection OAuth", async ({ page }) => {
  await page.goto("/login");
  await expectGoogleOAuthRedirect(page, origin);
});

test("@smoke connecteur MCP : métadonnées OAuth publiées, refus propre sans jeton", async ({ request }) => {
  const as = await (await request.get("/.well-known/oauth-authorization-server")).json();
  expect(as.issuer).toBe(origin);
  expect(as.authorization_endpoint).toBe(`${origin}/oauth/authorize`);
  expect(as.token_endpoint).toBe(`${origin}/oauth/token`);
  expect(as.code_challenge_methods_supported).toContain("S256");
  const pr = await (await request.get("/.well-known/oauth-protected-resource/mcp")).json();
  expect(pr.resource).toBe(`${origin}/mcp`);
  expect(pr.authorization_servers).toEqual([origin]);
  // Sans jeton, /mcp répond 401 avant tout accès à la base, en désignant ses métadonnées.
  const mcp = await request.post("/mcp", { data: { jsonrpc: "2.0", id: 1, method: "ping" } });
  expect(mcp.status()).toBe(401);
  expect(mcp.headers()["www-authenticate"] ?? "").toContain("resource_metadata");
});

test("@smoke fichiers publics de l'app : manifest et robots", async ({ request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  expect((await manifest.json()).name).toBe("Cortex");
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain("Disallow: /");
});
