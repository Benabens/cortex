/**
 * SERVEUR D'AUTORISATION DU CONNECTEUR MCP — flux OAuth 2.1 complet, par les
 * points HTTP (handlers des routes) et sur Postgres réel (PGlite) :
 * découverte → enregistrement → consentement → code + PKCE → jetons → rotation
 * → révocation. Les refus comptent autant que le chemin nominal : PKCE faux,
 * code rejoué, refresh volé, ressource étrangère, ticket d'un autre compte.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.MCP_ENABLED = "1";
process.env.AUTH_URL = "https://cortex.test";

const ISSUER = "https://cortex.test";
const RESOURCE = `${ISSUER}/mcp`;
const CALLBACK = "http://localhost:33418/callback";
const ALICE = "usr_alice_oauth";
const BOB = "usr_bob_oauth";

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL", "MCP_ENABLED", "AUTH_URL"]) delete process.env[k];
});

before(async () => {
  delete process.env.CORTEX_USER;
});

const get = (path: string) => new Request(`${ISSUER}${path}`);
const formPost = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${ISSUER}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function register(redirectUris = [CALLBACK], extra: Record<string, unknown> = {}) {
  const { registerEndpoint } = await import("../lib/oauth/routes");
  const res = await registerEndpoint(new Request(`${ISSUER}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Client de test", redirect_uris: redirectUris, token_endpoint_auth_method: "none", ...extra }),
  }));
  assert.equal(res.status, 201);
  return (await res.json()) as { client_id: string; client_secret?: string };
}

function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge,
    code_challenge_method: "S256", state: "etat-123", resource: RESOURCE, scope: "cortex.read cortex.generate", ...extra,
  });
}

/** Consentement accepté par `user` → code d'autorisation renvoyé au client. */
async function consent(user: string, clientId: string, challenge: string, opts: { generate?: boolean } = {}) {
  const { prepareConsent, consentDecisionEndpoint } = await import("../lib/oauth/routes");
  const view = await prepareConsent(get("/oauth/authorize"), authorizeParams(clientId, challenge), user);
  assert.equal(view.kind, "consent", JSON.stringify(view));
  if (view.kind !== "consent") throw new Error("unreachable");
  const res = await consentDecisionEndpoint(
    formPost("/oauth/authorize/decision", { ticket: view.ticket, decision: "approve", ...(opts.generate === false ? {} : { generate: "on" }) }, { origin: ISSUER }),
    user,
  );
  assert.equal(res.status, 303);
  const location = new URL(res.headers.get("location")!);
  assert.equal(`${location.origin}${location.pathname}`, CALLBACK);
  assert.equal(location.searchParams.get("state"), "etat-123");
  assert.equal(location.searchParams.get("iss"), ISSUER);
  return location.searchParams.get("code")!;
}

async function token(fields: Record<string, string>) {
  const { tokenEndpoint } = await import("../lib/oauth/routes");
  const res = await tokenEndpoint(formPost("/oauth/token", fields));
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function connect(user: string, opts: { generate?: boolean } = {}) {
  const client = await register();
  const { verifier, challenge } = pkce();
  const code = await consent(user, client.client_id, challenge, opts);
  const t = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CALLBACK, resource: RESOURCE });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const { access_token, refresh_token, token_type, scope } = t.body;
  return { clientId: client.client_id, code, verifier, access_token, refresh_token, token_type, scope };
}

async function principal(accessToken: string) {
  const { verifyAccessToken } = await import("../lib/oauth/server");
  return verifyAccessToken(accessToken, RESOURCE);
}

test("découverte : la ressource /mcp désigne Cortex comme serveur d'autorisation, PKCE S256 annoncé", async () => {
  const { authorizationServerMetadata, protectedResourceMetadata } = await import("../lib/oauth/routes");
  const prm = await (protectedResourceMetadata(get("/.well-known/oauth-protected-resource/mcp"))).json();
  assert.equal(prm.resource, RESOURCE);
  assert.deepEqual(prm.authorization_servers, [ISSUER]);
  const as = await (authorizationServerMetadata(get("/.well-known/oauth-authorization-server"))).json();
  assert.equal(as.issuer, ISSUER);
  assert.equal(as.token_endpoint, `${ISSUER}/oauth/token`);
  assert.equal(as.authorization_endpoint, `${ISSUER}/oauth/authorize`);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.client_id_metadata_document_supported, true);
});

test("sans MCP_ENABLED=1, aucun point OAuth n'est servi", async () => {
  const { authorizationServerMetadata, protectedResourceMetadata } = await import("../lib/oauth/routes");
  delete process.env.MCP_ENABLED;
  try {
    assert.equal(authorizationServerMetadata(get("/.well-known/oauth-authorization-server")).status, 404);
    assert.equal(protectedResourceMetadata(get("/.well-known/oauth-protected-resource/mcp")).status, 404);
  } finally {
    process.env.MCP_ENABLED = "1";
  }
});

test("flux complet : enregistrement, consentement, code + PKCE → jetons au nom du compte qui a consenti", async () => {
  const c = await connect(ALICE);
  assert.match(c.access_token, /^cx_at_/);
  assert.match(c.refresh_token, /^cx_rt_/);
  assert.equal(c.token_type, "Bearer");
  assert.equal(c.scope, "cortex.read cortex.generate");
  const p = await principal(c.access_token);
  assert.equal(p?.userId, ALICE);
  assert.deepEqual(p?.scopes, ["cortex.read", "cortex.generate"]);
});

test("case « générer » décochée : le jeton ne porte que la lecture", async () => {
  const c = await connect(ALICE, { generate: false });
  assert.equal(c.scope, "cortex.read");
  assert.deepEqual((await principal(c.access_token))?.scopes, ["cortex.read"]);
});

test("PKCE : un code_verifier faux est refusé, et le code ne resservira pas", async () => {
  const client = await register();
  const { verifier, challenge } = pkce();
  const code = await consent(ALICE, client.client_id, challenge);
  const wrong = await token({ grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: client.client_id });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, "invalid_grant");
  const retry = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id });
  assert.equal(retry.body.error, "invalid_grant", "un code présenté une fois est consommé, même en échec");
});

test("code rejoué : refusé, et les jetons déjà émis par ce code sont révoqués", async () => {
  const c = await connect(ALICE);
  const replay = await token({ grant_type: "authorization_code", code: c.code, code_verifier: c.verifier, client_id: c.clientId });
  assert.equal(replay.body.error, "invalid_grant");
  assert.equal(await principal(c.access_token), null);
});

test("code rejoué : seuls les jetons de CE code tombent, pas ceux d'un autre appareil du même compte", async () => {
  const client = await register();
  const a = pkce();
  const codeA = await consent(ALICE, client.client_id, a.challenge);
  const tA = await token({ grant_type: "authorization_code", code: codeA, code_verifier: a.verifier, client_id: client.client_id });
  const b = pkce();
  const codeB = await consent(ALICE, client.client_id, b.challenge);
  const tB = await token({ grant_type: "authorization_code", code: codeB, code_verifier: b.verifier, client_id: client.client_id });
  await token({ grant_type: "authorization_code", code: codeA, code_verifier: a.verifier, client_id: client.client_id });
  assert.equal(await principal(tA.body.access_token), null);
  assert.ok(await principal(tB.body.access_token), "l'autre appareil garde son accès");
});

test("demande sans PKCE ou en méthode plain : erreur renvoyée au client, aucun ticket", async () => {
  const { prepareConsent } = await import("../lib/oauth/routes");
  const client = await register();
  const noPkce = authorizeParams(client.client_id, "x");
  noPkce.delete("code_challenge");
  const v1 = await prepareConsent(get("/oauth/authorize"), noPkce, ALICE);
  assert.equal(v1.kind, "redirect");
  if (v1.kind === "redirect") assert.equal(new URL(v1.url).searchParams.get("error"), "invalid_request");
  const v2 = await prepareConsent(get("/oauth/authorize"), authorizeParams(client.client_id, pkce().challenge, { code_challenge_method: "plain" }), ALICE);
  assert.equal(v2.kind, "redirect");
});

test("URL de retour non enregistrée ou client inconnu : erreur AFFICHÉE, jamais de redirection", async () => {
  const { prepareConsent } = await import("../lib/oauth/routes");
  const client = await register();
  const evil = await prepareConsent(get("/oauth/authorize"), authorizeParams(client.client_id, pkce().challenge, { redirect_uri: "https://evil.example/cb" }), ALICE);
  assert.equal(evil.kind, "error");
  const unknown = await prepareConsent(get("/oauth/authorize"), authorizeParams("cx_client_inconnu", pkce().challenge), ALICE);
  assert.equal(unknown.kind, "error");
});

test("adresse de bouclage : le port peut changer (client natif), pas le chemin", async () => {
  const { prepareConsent } = await import("../lib/oauth/routes");
  const client = await register();
  const otherPort = await prepareConsent(get("/oauth/authorize"), authorizeParams(client.client_id, pkce().challenge, { redirect_uri: "http://localhost:51234/callback" }), ALICE);
  assert.equal(otherPort.kind, "consent");
  const otherPath = await prepareConsent(get("/oauth/authorize"), authorizeParams(client.client_id, pkce().challenge, { redirect_uri: "http://localhost:33418/autre" }), ALICE);
  assert.equal(otherPath.kind, "error");
});

test("ressource étrangère : refusée à l'autorisation comme au point de jeton", async () => {
  const { prepareConsent } = await import("../lib/oauth/routes");
  const client = await register();
  const v = await prepareConsent(get("/oauth/authorize"), authorizeParams(client.client_id, pkce().challenge, { resource: "https://autre-serveur.example/mcp" }), ALICE);
  assert.equal(v.kind, "redirect");
  if (v.kind === "redirect") assert.equal(new URL(v.url).searchParams.get("error"), "invalid_target");
  const c = await connect(ALICE);
  const t = await token({ grant_type: "refresh_token", refresh_token: c.refresh_token, client_id: c.clientId, resource: "https://autre-serveur.example/mcp" });
  assert.equal(t.body.error, "invalid_target");
});

test("un jeton émis pour une autre ressource n'ouvre pas ce point MCP", async () => {
  const c = await connect(ALICE);
  const { verifyAccessToken } = await import("../lib/oauth/server");
  assert.equal(await verifyAccessToken(c.access_token, "https://autre-serveur.example/mcp"), null);
});

test("le ticket de consentement d'Alice ne peut pas être accepté depuis le compte de Bob", async () => {
  const { prepareConsent, consentDecisionEndpoint } = await import("../lib/oauth/routes");
  const client = await register();
  const view = await prepareConsent(get("/oauth/authorize"), authorizeParams(client.client_id, pkce().challenge), ALICE);
  assert.equal(view.kind, "consent");
  if (view.kind !== "consent") return;
  const res = await consentDecisionEndpoint(formPost("/oauth/authorize/decision", { ticket: view.ticket, decision: "approve", generate: "on" }, { origin: ISSUER }), BOB);
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.origin, ISSUER, "Bob est renvoyé vers l'écran d'erreur de Cortex, pas vers le client");
  assert.equal(location.searchParams.get("code"), null);
});

test("décision postée depuis une autre origine : 403", async () => {
  const { prepareConsent, consentDecisionEndpoint } = await import("../lib/oauth/routes");
  const client = await register();
  const view = await prepareConsent(get("/oauth/authorize"), authorizeParams(client.client_id, pkce().challenge), ALICE);
  if (view.kind !== "consent") throw new Error("consent attendu");
  const res = await consentDecisionEndpoint(formPost("/oauth/authorize/decision", { ticket: view.ticket, decision: "approve" }, { origin: "https://evil.example" }), ALICE);
  assert.equal(res.status, 403);
});

test("refus : access_denied renvoyé au client avec son state", async () => {
  const { prepareConsent, consentDecisionEndpoint } = await import("../lib/oauth/routes");
  const client = await register();
  const view = await prepareConsent(get("/oauth/authorize"), authorizeParams(client.client_id, pkce().challenge), ALICE);
  if (view.kind !== "consent") throw new Error("consent attendu");
  const res = await consentDecisionEndpoint(formPost("/oauth/authorize/decision", { ticket: view.ticket, decision: "deny" }, { origin: ISSUER }), ALICE);
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.searchParams.get("error"), "access_denied");
  assert.equal(location.searchParams.get("state"), "etat-123");
});

test("refresh tournant : nouveau couple de jetons ; l'ancien refresh rejoué (hors tolérance) coupe sa lignée", async () => {
  process.env.OAUTH_REFRESH_GRACE_S = "0";
  try {
    const c = await connect(ALICE);
    const r1 = await token({ grant_type: "refresh_token", refresh_token: c.refresh_token, client_id: c.clientId });
    assert.equal(r1.status, 200);
    assert.notEqual(r1.body.refresh_token, c.refresh_token);
    assert.equal((await principal(r1.body.access_token))?.userId, ALICE);
    const stolen = await token({ grant_type: "refresh_token", refresh_token: c.refresh_token, client_id: c.clientId });
    assert.equal(stolen.body.error, "invalid_grant");
    assert.equal(await principal(r1.body.access_token), null, "la réutilisation d'un refresh révoque les jetons en cours");
    const later = await token({ grant_type: "refresh_token", refresh_token: r1.body.refresh_token, client_id: c.clientId });
    assert.equal(later.body.error, "invalid_grant");
  } finally {
    delete process.env.OAUTH_REFRESH_GRACE_S;
  }
});

test("réessai réseau : le même refresh présenté deux fois dans la tolérance est servi, rien n'est révoqué", async () => {
  const c = await connect(ALICE);
  const r1 = await token({ grant_type: "refresh_token", refresh_token: c.refresh_token, client_id: c.clientId });
  const r2 = await token({ grant_type: "refresh_token", refresh_token: c.refresh_token, client_id: c.clientId });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.ok(await principal(r1.body.access_token));
  assert.ok(await principal(r2.body.access_token));
});

test("portée retirée à la reconnexion : les jetons déjà émis perdent cortex.generate", async () => {
  const client = await register();
  const a = pkce();
  const t1 = await token({ grant_type: "authorization_code", code: await consent(BOB, client.client_id, a.challenge), code_verifier: a.verifier, client_id: client.client_id });
  assert.deepEqual((await principal(t1.body.access_token))?.scopes, ["cortex.read", "cortex.generate"]);
  const b = pkce();
  await consent(BOB, client.client_id, b.challenge, { generate: false });
  assert.deepEqual((await principal(t1.body.access_token))?.scopes, ["cortex.read"], "le jeton d'avant suit l'autorisation réduite");
  const r = await token({ grant_type: "refresh_token", refresh_token: t1.body.refresh_token, client_id: client.client_id });
  assert.equal(r.body.scope, "cortex.read");
});

test("un client qui ne demande que « générer » reçoit aussi la lecture (sans elle, rien ne marcherait)", async () => {
  const { grantableScopes } = await import("../lib/oauth/server");
  assert.deepEqual(grantableScopes("cortex.generate"), ["cortex.read", "cortex.generate"]);
  assert.deepEqual(grantableScopes("cortex.read"), ["cortex.read"]);
  // Aucune portée connue = toutes celles du serveur ; cortex.admin est ensuite retirée à tout autre compte que le propriétaire (mcp-admin.test).
  assert.deepEqual(grantableScopes("inconnu"), ["cortex.read", "cortex.generate", "cortex.admin"]);
});

test("en-tête Basic malformé au point de jeton : 401 invalid_client, jamais 500", async () => {
  const { tokenEndpoint } = await import("../lib/oauth/routes");
  const res = await tokenEndpoint(formPost("/oauth/token", { grant_type: "refresh_token", refresh_token: "x" }, { authorization: `Basic ${Buffer.from("%E0%A4%A:x").toString("base64")}` }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "invalid_client");
});

test("refresh présenté par un autre client : refusé", async () => {
  const c = await connect(ALICE);
  const other = await register();
  const t = await token({ grant_type: "refresh_token", refresh_token: c.refresh_token, client_id: other.client_id });
  assert.equal(t.body.error, "invalid_grant");
});

test("révocation RFC 7009 : révoquer le refresh coupe le jeton d'accès", async () => {
  const c = await connect(ALICE);
  const { revokeEndpoint } = await import("../lib/oauth/routes");
  const res = await revokeEndpoint(formPost("/oauth/revoke", { token: c.refresh_token, client_id: c.clientId }));
  assert.equal(res.status, 200);
  assert.equal(await principal(c.access_token), null);
  const unknown = await revokeEndpoint(formPost("/oauth/revoke", { token: "cx_rt_inconnu", client_id: c.clientId }));
  assert.equal(unknown.status, 200, "jeton inconnu : succès silencieux");
});

test("applications connectées : chacun ne voit et ne révoque que les siennes", async () => {
  const { listConnectedApps, revokeConnectedApp } = await import("../lib/oauth/server");
  const c = await connect(BOB);
  const apps = await listConnectedApps(BOB);
  assert.ok(apps.length >= 1);
  assert.equal(apps[0].host, "localhost:33418");
  assert.equal(apps[0].name, "Client de test");
  const grantId = (await principal(c.access_token))!.grantId;
  assert.ok(!(await listConnectedApps(ALICE)).some((a) => a.id === grantId), "Alice ne voit pas l'application de Bob");
  assert.equal(await revokeConnectedApp(ALICE, grantId), false, "Alice ne peut pas révoquer l'application de Bob");
  assert.ok(await principal(c.access_token));
  assert.equal(await revokeConnectedApp(BOB, grantId), true);
  assert.equal(await principal(c.access_token), null);
  assert.ok(!(await listConnectedApps(BOB)).some((a) => a.id === grantId));
});

test("client qui demande un secret (DCR) : enregistré comme client public PKCE, aucun secret émis", async () => {
  const { registerEndpoint } = await import("../lib/oauth/routes");
  const res = await registerEndpoint(new Request(`${ISSUER}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Avec secret", redirect_uris: [CALLBACK], token_endpoint_auth_method: "client_secret_post" }),
  }));
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.token_endpoint_auth_method, "none");
  assert.equal(body.client_secret, undefined);
  const { verifier, challenge } = pkce();
  const code = await consent(ALICE, body.client_id, challenge);
  const t = await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: body.client_id });
  assert.equal(t.status, 200);
});

test("enregistrement : URL de retour non https refusée, flux implicite refusé", async () => {
  const { registerEndpoint } = await import("../lib/oauth/routes");
  const post = (body: unknown) => registerEndpoint(new Request(`${ISSUER}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const r1 = await post({ redirect_uris: ["http://evil.example/cb"] });
  assert.equal(r1.status, 400);
  assert.equal((await r1.json()).error, "invalid_redirect_uri");
  const r2 = await post({ redirect_uris: [CALLBACK], response_types: ["token"] });
  assert.equal((await r2.json()).error, "invalid_client_metadata");
});

test("CIMD : le document est lu à l'adresse du client_id et doit s'y désigner lui-même", async () => {
  const { validateAuthorizeRequest } = await import("../lib/oauth/server");
  const clientId = "https://client.example/oauth/metadata.json";
  const doc = { client_id: clientId, client_name: "Client CIMD", redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" };
  const fetcher = async () => ({ body: JSON.stringify(doc), maxAgeS: 600 });
  const params = authorizeParams(clientId, pkce().challenge, { redirect_uri: "https://client.example/callback" });
  const ok = await validateAuthorizeRequest(params, ISSUER, RESOURCE, fetcher);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.request.client.kind, "cimd");
  const liar = "https://menteur.example/meta.json";
  const lying = async () => ({ body: JSON.stringify({ ...doc, client_id: clientId }), maxAgeS: null });
  const ko = await validateAuthorizeRequest(authorizeParams(liar, pkce().challenge, { redirect_uri: "https://client.example/callback" }), ISSUER, RESOURCE, lying);
  assert.equal(ko.ok, false, "un document qui désigne un autre client_id est refusé");
  const anonymous = "https://anonyme.example/meta.json";
  const noName = async () => ({ body: JSON.stringify({ client_id: anonymous, redirect_uris: ["https://anonyme.example/cb"] }), maxAgeS: null });
  const ko2 = await validateAuthorizeRequest(authorizeParams(anonymous, pkce().challenge, { redirect_uri: "https://anonyme.example/cb" }), ISSUER, RESOURCE, noName);
  assert.equal(ko2.ok, false, "client_name est obligatoire dans un document CIMD");
});

test("CIMD : le vrai document de claude.ai (grant_types avec jwt-bearer en plus) est accepté", async () => {
  const { validateAuthorizeRequest } = await import("../lib/oauth/server");
  // Relevé tel quel sur https://claude.ai/oauth/mcp-oauth-client-metadata le 27/10/2026 : il déclare un type
  // de grant que Cortex ne sert pas ; le refuser bloquait la connexion de claude.ai (« Application inconnue »).
  const clientId = "https://claude.ai/oauth/mcp-oauth-client-metadata";
  const doc = {
    client_id: clientId, client_name: "Claude", client_uri: "https://claude.ai",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
    response_types: ["code"], token_endpoint_auth_method: "none",
  };
  const fetcher = async () => ({ body: JSON.stringify(doc), maxAgeS: 300 });
  const ok = await validateAuthorizeRequest(authorizeParams(clientId, pkce().challenge, { redirect_uri: "https://claude.ai/api/mcp/auth_callback" }), ISSUER, RESOURCE, fetcher);
  assert.equal(ok.ok, true, "claude.ai doit pouvoir se connecter");
  const noCode = "https://sanscode.example/meta.json";
  const noCodeDoc = async () => ({ body: JSON.stringify({ ...doc, client_id: noCode, redirect_uris: ["https://sanscode.example/cb"], grant_types: ["refresh_token"] }), maxAgeS: null });
  const ko = await validateAuthorizeRequest(authorizeParams(noCode, pkce().challenge, { redirect_uri: "https://sanscode.example/cb" }), ISSUER, RESOURCE, noCodeDoc);
  assert.equal(ko.ok, false, "un client qui ne déclare pas authorization_code reste refusé");
});

test("CIMD : seules les adresses publiques peuvent être lues (pas de SSRF vers le réseau interne)", async () => {
  const { isPublicAddress } = await import("../lib/oauth/clients");
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["104.18.1.1", "2606:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
});

test("route Applications connectées : GET liste celles du compte, DELETE d'une autre → 404, de la sienne → révoquée", async () => {
  const { GET, DELETE } = await import("../app/api/account/connected-apps/route");
  const { NextRequest } = await import("next/server");
  const c = await connect(BOB);
  const grantId = (await principal(c.access_token))!.grantId;
  const as = (user: string, method = "GET", query = "") =>
    new NextRequest(`${ISSUER}/api/account/connected-apps${query}`, { method, headers: { "x-cortex-user": user } });
  const listed = await (await GET(as(BOB))).json();
  assert.ok(listed.apps.some((a: { id: string }) => a.id === grantId));
  assert.ok(!(await (await GET(as(ALICE))).json()).apps.some((a: { id: string }) => a.id === grantId));
  assert.equal((await DELETE(as(ALICE, "DELETE", `?id=${grantId}`))).status, 404);
  assert.ok(await principal(c.access_token), "la tentative d'Alice n'a rien révoqué");
  assert.equal((await DELETE(as(BOB, "DELETE", `?id=${grantId}`))).status, 200);
  assert.equal(await principal(c.access_token), null);
});

test("CORS : seules les origines admises (app, Claude, poste local) sont reflétées, jamais « * »", async () => {
  const { authorizationServerMetadata, tokenEndpoint } = await import("../lib/oauth/routes");
  const withOrigin = (origin: string) => new Request(`${ISSUER}/.well-known/oauth-authorization-server`, { headers: { origin } });
  for (const origin of ["https://claude.ai", "http://localhost:6274", ISSUER]) {
    const res = authorizationServerMetadata(withOrigin(origin));
    assert.equal(res.headers.get("access-control-allow-origin"), origin, origin);
    assert.match(res.headers.get("vary") ?? "", /Origin/i);
  }
  const evil = authorizationServerMetadata(withOrigin("https://evil.example"));
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  const t = await tokenEndpoint(formPost("/oauth/token", { grant_type: "refresh_token", refresh_token: "x", client_id: "y" }, { origin: "https://evil.example" }));
  assert.notEqual(t.headers.get("access-control-allow-origin"), "*");
});

test("écran d'erreur du consentement : aucun texte venu de l'URL n'est affiché tel quel", async () => {
  const { prepareConsent } = await import("../lib/oauth/routes");
  const forged = await prepareConsent(get("/oauth/authorize"), new URLSearchParams({ error: "Ton compte est piraté, appelle le 0800 000 000" }), ALICE);
  assert.equal(forged.kind, "error");
  if (forged.kind === "error") assert.ok(!forged.message.includes("0800"), forged.message);
  const expired = await prepareConsent(get("/oauth/authorize"), new URLSearchParams({ error: "expired" }), ALICE);
  if (expired.kind === "error") assert.match(expired.message, /expirée/);
});

test("consentement d'un client CIMD qui revient sur localhost : domaine du client ET retour local signalés", async () => {
  const { findClient } = await import("../lib/oauth/clients");
  const { prepareConsent } = await import("../lib/oauth/routes");
  const clientId = "https://claude.ai/oauth/claude-code-client-metadata";
  const doc = { client_id: clientId, client_name: "Claude Code", redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"], token_endpoint_auth_method: "none" };
  await findClient(clientId, async () => ({ body: JSON.stringify(doc), maxAgeS: 3600 })); // met le document en cache
  const view = await prepareConsent(get("/oauth/authorize"), authorizeParams(clientId, pkce().challenge, { redirect_uri: "http://localhost:51999/callback" }), ALICE);
  assert.equal(view.kind, "consent");
  if (view.kind !== "consent") return;
  assert.equal(view.clientHost, "claude.ai");
  assert.equal(view.redirectHost, "localhost:51999");
  assert.equal(view.localRedirect, true, "un retour sur l'ordinateur doit être signalé : n'importe quel programme local peut s'y placer");
  const web = await prepareConsent(get("/oauth/authorize"), authorizeParams((await register()).client_id, pkce().challenge), ALICE);
  if (web.kind === "consent") assert.equal(web.localRedirect, true, CALLBACK);
});
