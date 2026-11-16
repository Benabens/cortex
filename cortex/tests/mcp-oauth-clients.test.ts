/**
 * CLIENTS MCP AUTRES QUE CLAUDE — ce qu'envoient réellement ChatGPT et Cursor
 * (relevé le 16/11/2026), et ce qu'un imposteur pourrait tenter :
 *  - ChatGPT : document CIMD https://chatgpt.com/oauth/client.json, qui préfère
 *    private_key_jwt mais accepte « none » ; retour stable
 *    https://chatgpt.com/connector_platform_oauth_redirect (ou /connector/oauth/{id}
 *    s'il s'enregistre par DCR) ; il peut joindre une assertion JWT au point de jeton ;
 *  - Cursor : DCR avec http://localhost:8787/callback ET cursor://… (refusé par la
 *    spec MCP) dans le même lot ;
 *  - un nom « ChatGPT » sur une adresse qui n'est pas celle de ChatGPT n'est
 *    jamais affiché comme ChatGPT.
 * Postgres réel en mémoire (PGlite), par les points HTTP comme tests/mcp-oauth.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.MCP_ENABLED = "1";
process.env.AUTH_URL = "https://cortex.test";

const ISSUER = "https://cortex.test";
const RESOURCE = `${ISSUER}/mcp`;
const ALICE = "usr_alice_clients";
const CHATGPT_ID = "https://chatgpt.com/oauth/client.json";
const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

/** Document CIMD publié par ChatGPT, tel quel (16/11/2026). */
const CHATGPT_DOC = {
  client_id: CHATGPT_ID,
  client_uri: "https://chatgpt.com/",
  redirect_uris: [CHATGPT_REDIRECT],
  token_endpoint_auth_method: "private_key_jwt",
  token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
  response_types: ["code"],
  client_name: "ChatGPT",
  logo_uri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
  token_endpoint_auth_signing_alg: "RS256",
  jwks_uri: "https://chatgpt.com/oauth/jwks.json",
};

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL", "MCP_ENABLED", "AUTH_URL"]) delete process.env[k];
});

const get = (p: string) => new Request(`${ISSUER}${p}`);
const formPost = (p: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${ISSUER}${p}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
}

const authorizeParams = (clientId: string, challenge: string, redirectUri: string) => new URLSearchParams({
  response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
  code_challenge_method: "S256", state: "etat", resource: RESOURCE, scope: "cortex.read",
});

async function registerRaw(body: Record<string, unknown>) {
  const { registerEndpoint } = await import("../lib/oauth/routes");
  return registerEndpoint(new Request(`${ISSUER}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token_endpoint_auth_method: "none", ...body }),
  }));
}

/** Assertion JWT non signée (ChatGPT signe en RS256 ; Cortex ne la vérifie pas, elle ne fait que nommer le client). */
const assertion = (sub: string) =>
  [{ alg: "RS256", typ: "JWT" }, { iss: sub, sub, aud: `${ISSUER}/oauth/token`, exp: Math.floor(Date.now() / 1000) + 300 }]
    .map((p) => Buffer.from(JSON.stringify(p)).toString("base64url")).join(".") + ".signature";

// ───────────────────────────── ChatGPT ─────────────────────────────

test("ChatGPT (CIMD) : son document réel est accepté, le consentement le nomme « ChatGPT · chatgpt.com »", async () => {
  const { findClient } = await import("../lib/oauth/clients");
  const { prepareConsent } = await import("../lib/oauth/routes");
  const client = await findClient(CHATGPT_ID, async () => ({ body: JSON.stringify(CHATGPT_DOC), maxAgeS: 3600 }));
  assert.ok(client, "document CIMD de ChatGPT refusé");
  const view = await prepareConsent(get("/oauth/authorize"), authorizeParams(CHATGPT_ID, pkce().challenge, CHATGPT_REDIRECT), ALICE);
  assert.equal(view.kind, "consent", JSON.stringify(view));
  if (view.kind !== "consent") return;
  assert.deepEqual(view.recognized, { label: "ChatGPT", domain: "chatgpt.com" });
  assert.equal(view.verifiedDomain, true);
  assert.equal(view.impersonates, null);
});

test("ChatGPT (CIMD) : un client qui n'accepte QUE private_key_jwt reste refusé", async () => {
  const { findClient, parseCimdDocument } = await import("../lib/oauth/clients");
  const id = "https://jwt-only.example/client.json";
  const doc = { ...CHATGPT_DOC, client_id: id, redirect_uris: ["https://jwt-only.example/cb"], token_endpoint_auth_methods_supported: ["private_key_jwt"] };
  assert.throws(() => parseCimdDocument(id, JSON.stringify(doc)), /clients publics/);
  assert.equal(await findClient(id, async () => ({ body: JSON.stringify(doc), maxAgeS: null })), null);
});

test("ChatGPT : le jeton s'obtient avec l'assertion JWT seule (sans client_id), PKCE fait foi", async () => {
  const { consentDecisionEndpoint, prepareConsent, tokenEndpoint } = await import("../lib/oauth/routes");
  const { verifier, challenge } = pkce();
  const view = await prepareConsent(get("/oauth/authorize"), authorizeParams(CHATGPT_ID, challenge, CHATGPT_REDIRECT), ALICE);
  assert.equal(view.kind, "consent");
  if (view.kind !== "consent") return;
  const decided = await consentDecisionEndpoint(formPost("/oauth/authorize/decision", { ticket: view.ticket, decision: "approve" }, { origin: ISSUER }), ALICE);
  const back = new URL(decided.headers.get("location")!);
  assert.equal(`${back.origin}${back.pathname}`, CHATGPT_REDIRECT);
  assert.equal(back.searchParams.get("iss"), ISSUER, "ChatGPT n'utilise son retour stable que si l'émetteur est renvoyé");
  const code = back.searchParams.get("code")!;
  const exchange = (fields: Record<string, string>) => tokenEndpoint(formPost("/oauth/token", {
    grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CHATGPT_REDIRECT, resource: RESOURCE,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", ...fields,
  }));
  // Assertion au nom d'un autre client : le code ne lui appartient pas.
  const stolen = await exchange({ client_assertion: assertion("https://autre.example/client.json") });
  assert.notEqual(stolen.status, 200);
  const res = await exchange({ client_assertion: assertion(CHATGPT_ID) });
  const body = (await res.json()) as { access_token?: string; error?: string };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.match(body.access_token ?? "", /^cx_at_/);
});

test("ChatGPT (DCR) : retours stable et par connecteur acceptés et reconnus ; nom imité sur une autre adresse signalé", async () => {
  const { prepareConsent } = await import("../lib/oauth/routes");
  for (const redirect of [CHATGPT_REDIRECT, "https://chatgpt.com/connector/oauth/cb_3fA9-x_1"]) {
    const res = await registerRaw({ client_name: "ChatGPT", redirect_uris: [redirect] });
    assert.equal(res.status, 201, redirect);
    const { client_id } = (await res.json()) as { client_id: string };
    const view = await prepareConsent(get("/oauth/authorize"), authorizeParams(client_id, pkce().challenge, redirect), ALICE);
    assert.equal(view.kind, "consent", redirect);
    if (view.kind === "consent") assert.deepEqual(view.recognized, { label: "ChatGPT", domain: "chatgpt.com" }, redirect);
  }
  for (const redirect of [
    "https://chatgpt.com.evil.example/connector_platform_oauth_redirect",
    "https://evil.example/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector/oauth/a/../../../evil",
  ]) {
    const res = await registerRaw({ client_name: "ChatGPT", redirect_uris: [redirect] });
    assert.equal(res.status, 201, redirect);
    const { client_id } = (await res.json()) as { client_id: string };
    const view = await prepareConsent(get("/oauth/authorize"), authorizeParams(client_id, pkce().challenge, redirect), ALICE);
    assert.equal(view.kind, "consent", redirect);
    if (view.kind !== "consent") continue;
    assert.equal(view.recognized, null, `${redirect} reconnu comme ChatGPT`);
    assert.equal(view.impersonates, "ChatGPT", `${redirect} : imitation non signalée`);
  }
});

test("reconnaissance : seules l'identité CIMD et l'URL de retour https exacte comptent", async () => {
  const { recognizeClient, impersonatedClient } = await import("../lib/oauth/known-clients");
  const label = (clientId: string, redirectUri: string, viaCimd = false) => recognizeClient({ clientId, viaCimd, redirectUri })?.label ?? null;
  assert.equal(label("dcr_x", CHATGPT_REDIRECT), "ChatGPT");
  assert.equal(label("dcr_x", "https://claude.ai/api/mcp/auth_callback"), "Claude");
  assert.equal(label("https://claude.ai/oauth/claude-code-client-metadata", "http://localhost:5555/callback", true), "Claude Code");
  assert.equal(label("dcr_x", "https://vscode.dev/redirect"), "VS Code");
  for (const bad of [
    "http://chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com@evil.example/connector_platform_oauth_redirect",
    "https://evil.chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com:8443/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector_platform_oauth_redirect/x",
    "https://chatgpt.com/connector_platform_oauth_redirect?next=https://evil.example",
    "https://chatgpt.com/connector/oauth/",
    "https://chatgpt.com/connector/oauth/a.b",
    "https://chatgpt.com/connector/oauth/a%2F..",
    "https://CHATGPT.com/connector_platform_oauth_redirect",
    "http://localhost:8787/callback",
  ]) assert.equal(label("dcr_x", bad), null, bad);
  // Un client_id qui ressemble à celui de ChatGPT ne prouve rien hors CIMD, ni sur un autre domaine.
  assert.equal(label(CHATGPT_ID, "https://evil.example/cb", false), null);
  assert.equal(label("https://chatgpt.com.evil.example/oauth/client.json", "https://evil.example/cb", true), null);
  assert.equal(impersonatedClient("Chat GPT"), impersonatedClient("ChatGPT"));
  assert.equal(impersonatedClient("Claude Desktop")?.label, "Claude");
  assert.equal(impersonatedClient("Mon client"), null);
});

// ───────────────────────────── Cursor ─────────────────────────────

test("Cursor (DCR) : retour local gardé, cursor:// écarté au lieu de refuser tout l'enregistrement", async () => {
  const { validateAuthorizeRequest } = await import("../lib/oauth/server");
  const res = await registerRaw({ client_name: "Cursor", redirect_uris: ["http://localhost:8787/callback", "cursor://anysphere.cursor-mcp/oauth/callback"] });
  assert.equal(res.status, 201);
  const reg = (await res.json()) as { client_id: string; redirect_uris: string[] };
  assert.deepEqual(reg.redirect_uris, ["http://localhost:8787/callback"], "la réponse dit au client ce qui a été retenu");
  const ok = await validateAuthorizeRequest(authorizeParams(reg.client_id, pkce().challenge, "http://localhost:8787/callback"), ISSUER, RESOURCE);
  assert.equal(ok.ok, true);
  const dropped = await validateAuthorizeRequest(authorizeParams(reg.client_id, pkce().challenge, "cursor://anysphere.cursor-mcp/oauth/callback"), ISSUER, RESOURCE);
  assert.equal(dropped.ok, false);
  assert.ok(!("redirect" in dropped), "jamais de redirection vers une adresse écartée");
  // Rien d'acceptable : refus, comme avant.
  const none = await registerRaw({ redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback", "http://evil.example/cb"] });
  assert.equal(none.status, 400);
  assert.equal(((await none.json()) as { error: string }).error, "invalid_redirect_uri");
});

// ───────────────────────────── métadonnées et page de consentement ─────────────────────────────

test("métadonnées : documentation, politique de confidentialité et conditions annoncées (RFC 8414, RFC 9728)", async () => {
  const { authorizationServerMetadata, protectedResourceMetadata } = await import("../lib/oauth/routes");
  const as = (await (await authorizationServerMetadata(get("/.well-known/oauth-authorization-server"))).json()) as Record<string, unknown>;
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal(as.service_documentation, "https://cortexexam.com/mcp");
  assert.equal(as.op_policy_uri, "https://cortexexam.com/privacy-en");
  const prm = (await (await protectedResourceMetadata(get("/.well-known/oauth-protected-resource/mcp"))).json()) as Record<string, unknown>;
  assert.equal(prm.resource, RESOURCE);
  assert.equal(prm.resource_documentation, "https://cortexexam.com/mcp");
  assert.equal(prm.resource_policy_uri, "https://cortexexam.com/privacy-en");
  assert.equal(prm.resource_tos_uri, "https://cortexexam.com/terms-en");
});

test("origines de navigateur : ChatGPT et VS Code pour le web admis, un sous-domaine imité non", async () => {
  const { allowedOriginHosts } = await import("../lib/oauth/cors");
  const hosts = allowedOriginHosts(ISSUER);
  for (const h of ["cortex.test", "claude.ai", "claude.com", "chatgpt.com", "vscode.dev", "localhost"]) assert.ok(hosts.includes(h), h);
  for (const h of ["chatgpt.com.evil.example", "evil.chatgpt.com", "openai.com"]) assert.ok(!hosts.includes(h), h);
});

test("page de consentement : aucun nom d'assistant écrit en dur, lien vers la marche à suivre", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "app", "oauth", "authorize", "page.tsx"), "utf8");
  const visible = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(visible, /\b(Claude|ChatGPT|OpenAI|Cursor|Gemini)\b/);
  assert.match(visible, /href="\/compte\/assistants"/);
});
