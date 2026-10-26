import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";

/**
 * CONNECTEUR MCP AU PROXY — un client MCP n'a pas de cookie de session : /mcp,
 * les métadonnées OAuth et les points /oauth/{register,token,revoke} doivent
 * l'atteindre (le jeton Bearer est vérifié plus loin), alors que l'écran de
 * consentement /oauth/authorize reste derrière la session de l'app. La limite
 * par IP compte /mcp par jeton : derrière claude.ai, tous les comptes partagent
 * les mêmes adresses de sortie.
 */

(process.env as Record<string, string | undefined>).AUTH_ENABLED = "1";

test("auth active : /mcp, métadonnées et points OAuth passent sans session ; le consentement non", async () => {
  const { publicPath } = await import("../proxy");
  for (const p of [
    "/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server", "/oauth/register", "/oauth/token", "/oauth/revoke",
  ]) assert.equal(publicPath(p), true, p);
  for (const p of ["/oauth/authorize", "/oauth/authorize/decision", "/mcp-admin", "/mcpx", "/oauth", "/.well-known/autre", "/api/account/connected-apps"]) {
    assert.equal(publicPath(p), false, p);
  }
});

test("auth active : POST /mcp sans cookie n'est pas redirigé vers /login", async () => {
  const { default: proxy } = await import("../proxy");
  const res = await proxy(new NextRequest("http://cortex.test/mcp", { method: "POST", headers: { authorization: "Bearer cx_at_x" } }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null);
});

test("limite par IP : /mcp est compté par jeton, pas par adresse de sortie partagée", async () => {
  process.env.RATE_LIMIT_PER_MIN = "2";
  try {
    const { default: proxy } = await import("../proxy");
    const call = (token: string) => proxy(new NextRequest("http://cortex.test/mcp", { method: "POST", headers: { authorization: `Bearer ${token}` } }));
    const a = "cx_at_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const b = "cx_at_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    assert.equal((await call(a)).status, 200);
    assert.equal((await call(a)).status, 200);
    assert.equal((await call(a)).status, 429, "le même jeton au-delà de la limite est freiné");
    assert.equal((await call(b)).status, 200, "un autre compte derrière la même IP ne l'est pas");
  } finally {
    delete process.env.RATE_LIMIT_PER_MIN;
  }
});
