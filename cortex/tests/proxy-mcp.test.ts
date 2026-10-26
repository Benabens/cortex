import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";

/**
 * CONNECTEUR MCP AU PROXY — un client MCP n'a pas de cookie de session : /mcp,
 * les métadonnées OAuth et les points /oauth/{register,token,revoke} doivent
 * l'atteindre (le jeton Bearer est vérifié plus loin), alors que l'écran de
 * consentement /oauth/authorize reste derrière la session de l'app. La limite
 * par IP s'applique à /mcp comme ailleurs : un jeton (même inventé) n'ouvre pas
 * de compteur à part ; l'équité entre comptes est assurée au point MCP.
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

test("limite par IP : un jeton inventé ne contourne pas la limite sur /mcp", async () => {
  process.env.RATE_LIMIT_PER_MIN = "2";
  process.env.TRUST_PROXY = "1"; // IP lue dans x-forwarded-for : un compteur neuf pour ce test
  try {
    const { default: proxy } = await import("../proxy");
    const call = (token: string) => proxy(new NextRequest("http://cortex.test/mcp", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.9" },
    }));
    assert.equal((await call("cx_at_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status, 200);
    assert.equal((await call("cx_at_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB")).status, 200);
    assert.equal((await call("cx_at_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC")).status, 429, "changer de jeton ne remet pas le compteur de l'IP à zéro");
  } finally {
    delete process.env.RATE_LIMIT_PER_MIN;
    delete process.env.TRUST_PROXY;
  }
});
