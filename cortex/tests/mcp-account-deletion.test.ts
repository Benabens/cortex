/**
 * SUPPRESSION DE COMPTE ET CONNECTEUR MCP — effacer un compte coupe ses
 * applications connectées : jetons inutilisables, autorisations, codes,
 * tickets et devis effacés. Le compte voisin garde les siens.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-mcp-del-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.MCP_ENABLED = "1";
process.env.AUTH_URL = "https://cortex.test";
delete process.env.CORTEX_USER;
delete process.env.CORTEX_OWNER_EMAIL;
delete process.env.CORTEX_OWNER_USER_ID;

const ISSUER = "https://cortex.test";
const RESOURCE = `${ISSUER}/mcp`;
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["CORTEX_DATA_DIR", "DB_DRIVER", "DATABASE_URL", "MCP_ENABLED", "AUTH_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function connect(user: string): Promise<string> {
  const { authRun } = await import("../db/auth-store");
  await authRun(`INSERT INTO users (id, email, name) VALUES (?,?,?) ON CONFLICT (id) DO NOTHING`, user, `${user}@exemple.ch`, user);
  const { registerClient } = await import("../lib/oauth/clients");
  const { validateAuthorizeRequest, createConsentTicket, decideConsent, exchangeToken } = await import("../lib/oauth/server");
  const { client } = await registerClient({ client_name: "Claude", redirect_uris: [CALLBACK] });
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const v = await validateAuthorizeRequest(new URLSearchParams({
    response_type: "code", client_id: client.clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE,
  }), ISSUER, RESOURCE);
  if (!v.ok) throw new Error("demande refusée");
  const ticket = await createConsentTicket(user, v.request);
  // Un second ticket resté en attente doit lui aussi disparaître.
  await createConsentTicket(user, v.request);
  const code = new URL(await decideConsent(user, ticket, true, ISSUER)).searchParams.get("code")!;
  const t = await exchangeToken(new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.clientId }), null, RESOURCE);
  const { issueQuote } = await import("../lib/mcp/quotes");
  const { verifyAccessToken } = await import("../lib/oauth/server");
  const p = (await verifyAccessToken(t.access_token, RESOURCE))!;
  await issueQuote({ userId: user, grantId: p.grantId, tool: "generate_drill", args: { concept: "x" }, costCenti: 10 });
  return t.access_token;
}

test("supprimer un compte révoque ses applications connectées et efface leurs traces, sans toucher au voisin", async () => {
  const gone = await connect("usr_part");
  const stays = await connect("usr_reste");
  const { deleteAccount } = await import("../lib/account-deletion");
  const { verifyAccessToken } = await import("../lib/oauth/server");
  const { authGet } = await import("../db/auth-store");
  const res = await deleteAccount("usr_part");
  assert.equal(res.deleted, true, JSON.stringify(res.errors));
  assert.equal(await verifyAccessToken(gone, RESOURCE), null);
  for (const table of ["oauth_grants", "oauth_tokens", "oauth_codes", "oauth_requests", "mcp_quotes"]) {
    const n = await authGet<{ n: number }>(`SELECT count(*) n FROM ${table} WHERE user_id = ?`, "usr_part");
    assert.equal(Number(n?.n ?? 0), 0, `${table} : lignes restantes`);
  }
  assert.ok(await verifyAccessToken(stays, RESOURCE), "le compte voisin garde son application");
});
