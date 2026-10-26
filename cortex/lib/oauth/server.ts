import { authAll, authGet, authRun, authTx } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { findClient, redirectUriMatches, type MetadataFetcher, type OAuthClient } from "./clients";
import {
  ACCESS_TOKEN_TTL_S, AUTH_CODE_TTL_S, CONSENT_TTL_S, REFRESH_TOKEN_TTL_S, SCOPE_GENERATE, SCOPE_READ, SUPPORTED_SCOPES,
  canonicalResource,
} from "./config";
import { digest, newId, newSecret, pkceChallenge, safeEqual } from "./secrets";

/**
 * SERVEUR D'AUTORISATION OAuth 2.1 du connecteur MCP (docs/MCP.md, § Flux OAuth).
 *
 * Flux unique : code d'autorisation + PKCE S256 obligatoire, indicateur de
 * ressource (RFC 8707) lié au jeton, jetons opaques courts + refresh TOURNANT
 * (réutilisation d'un refresh déjà tourné = vol présumé → toute l'autorisation
 * est révoquée), révocation (RFC 7009). Chaque connexion acceptée est une
 * AUTORISATION (grant) visible et révocable dans « Applications connectées ».
 *
 * Tout ce qui est secret (code, jeton, ticket de consentement) n'existe en
 * base que sous forme d'empreinte. Les décisions lire-puis-écrire à usage
 * unique (code, ticket, refresh) passent par une transaction du store global.
 */

export class OAuthError extends Error {
  constructor(readonly code: string, readonly description: string, readonly status = 400) {
    super(description);
    this.name = "OAuthError";
  }
}

const iso = (offsetS: number) => nowStr(offsetS * 1000);

// ─────────────────────────── demande d'autorisation ───────────────────────────

export type AuthorizeRequest = {
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scopes: string[];
  resource: string;
};

/**
 * Erreur d'une demande d'autorisation. `redirect` = l'URL de retour est sûre
 * (client connu, URL enregistrée) : l'erreur y est renvoyée. Sinon elle est
 * AFFICHÉE — rediriger vers une URL non vérifiée ferait de Cortex un
 * redirecteur ouvert.
 */
export type AuthorizeFailure = { ok: false; display: string } | { ok: false; redirect: string };

/**
 * Portées demandées → portées servies. Inconnues ignorées ; aucune portée connue
 * = toutes. La lecture est toujours incluse : sans elle, aucun outil ne répond
 * (et l'écran de consentement la promet de toute façon).
 */
export function grantableScopes(raw: string | null): string[] {
  const asked = (raw ?? "").split(/\s+/).filter((s) => (SUPPORTED_SCOPES as readonly string[]).includes(s));
  if (!asked.length) return [...SUPPORTED_SCOPES];
  return SUPPORTED_SCOPES.filter((s) => s === SCOPE_READ || asked.includes(s));
}

/** Intersection de deux listes de portées séparées par des espaces, dans l'ordre de la première. */
function intersectScopes(a: string, b: string): string {
  const allowed = new Set(b.split(" ").filter(Boolean));
  return a.split(" ").filter((s) => s && allowed.has(s)).join(" ");
}

function errorRedirect(redirectUri: string, issuer: string, state: string | null, code: string, description: string): string {
  const u = new URL(redirectUri);
  u.searchParams.set("error", code);
  u.searchParams.set("error_description", description);
  if (state !== null) u.searchParams.set("state", state);
  u.searchParams.set("iss", issuer);
  return u.toString();
}

/**
 * Valide les paramètres de /oauth/authorize. Ordre imposé par RFC 6749 §4.1.2.1 :
 * d'abord le client et l'URL de retour (sinon affichage), ensuite le reste (renvoyé
 * au client). `resource` absent = la ressource MCP de cette instance.
 */
export async function validateAuthorizeRequest(
  params: URLSearchParams, issuer: string, mcpResource: string, fetcher?: MetadataFetcher,
): Promise<{ ok: true; request: AuthorizeRequest } | AuthorizeFailure> {
  const clientId = params.get("client_id") ?? "";
  const client = clientId ? await findClient(clientId, fetcher) : null;
  if (!client) return { ok: false, display: "Application inconnue : son identifiant (client_id) n'est pas reconnu par Cortex." };
  const redirectUri = params.get("redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : "");
  if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) {
    return { ok: false, display: "Adresse de retour non enregistrée pour cette application : connexion refusée." };
  }
  const state = params.get("state");
  const fail = (code: string, description: string): AuthorizeFailure =>
    ({ ok: false, redirect: errorRedirect(redirectUri, issuer, state, code, description) });

  if (params.get("response_type") !== "code") return fail("unsupported_response_type", "Seul response_type=code est servi.");
  const challenge = params.get("code_challenge") ?? "";
  if (!challenge) return fail("invalid_request", "PKCE obligatoire : code_challenge manquant.");
  if (params.get("code_challenge_method") !== "S256") return fail("invalid_request", "PKCE : seule la méthode S256 est acceptée.");
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail("invalid_request", "code_challenge invalide (S256 attendu).");
  const rawResource = params.get("resource");
  const resource = rawResource === null ? mcpResource : canonicalResource(rawResource);
  if (resource !== canonicalResource(mcpResource)) return fail("invalid_target", "Ressource inconnue : ce serveur ne délivre de jetons que pour son point MCP.");
  return {
    ok: true,
    request: { client, redirectUri, state, codeChallenge: challenge, scopes: grantableScopes(params.get("scope")), resource: mcpResource },
  };
}

/**
 * Ticket de consentement : la demande validée est mise de côté, liée au compte
 * connecté, le temps que la personne accepte ou refuse. Le formulaire ne porte
 * que ce ticket (opaque, 10 min, usage unique) — jamais les paramètres OAuth,
 * qu'on ne pourrait plus faire confiance au retour.
 */
export async function createConsentTicket(userId: string, r: AuthorizeRequest): Promise<string> {
  const ticket = newSecret("req");
  await authRun(`DELETE FROM oauth_requests WHERE expires_at < ?`, nowStr(-86400_000));
  await authRun(
    `INSERT INTO oauth_requests (id_hash, user_id, client_id, redirect_uri, code_challenge, scope, resource, state, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    digest(ticket), userId, r.client.clientId, r.redirectUri, r.codeChallenge, r.scopes.join(" "), r.resource, r.state,
    nowStr(), iso(CONSENT_TTL_S),
  );
  return ticket;
}

type RequestRow = { user_id: string; client_id: string; redirect_uri: string; code_challenge: string; scope: string; resource: string; state: string | null };

/**
 * Décision de la personne sur un ticket. Accepter crée (ou met à jour)
 * l'autorisation et émet un code à usage unique (60 s) ; refuser renvoie
 * access_denied. Renvoie l'URL vers laquelle rediriger le navigateur.
 * `withGenerate` = la case « générer » est restée cochée (sinon lecture seule).
 */
export async function decideConsent(
  userId: string, ticket: string, approve: boolean, issuer: string, withGenerate: boolean,
): Promise<string> {
  const now = nowStr();
  const row = await authTx((tx) => tx.get<RequestRow>(
    `UPDATE oauth_requests SET consumed_at = ? WHERE id_hash = ? AND user_id = ? AND consumed_at IS NULL AND expires_at > ?
     RETURNING user_id, client_id, redirect_uri, code_challenge, scope, resource, state`,
    now, digest(ticket), userId, now,
  ));
  if (!row) throw new OAuthError("invalid_request", "Demande de connexion expirée ou déjà traitée : recommence depuis ton application.");
  if (!approve) return errorRedirect(row.redirect_uri, issuer, row.state, "access_denied", "La personne a refusé l'accès.");

  const client = await findClient(row.client_id);
  if (!client) throw new OAuthError("invalid_client", "Application inconnue.");
  const scopes = row.scope.split(" ").filter((s) => withGenerate || s !== SCOPE_GENERATE);
  if (!scopes.length) scopes.push(SCOPE_READ);
  const grantId = await upsertGrant(userId, client, row.redirect_uri, scopes.join(" "), row.resource);
  const code = newSecret("code");
  await authRun(`DELETE FROM oauth_codes WHERE expires_at < ?`, nowStr(-86400_000));
  await authRun(
    `INSERT INTO oauth_codes (code_hash, grant_id, user_id, client_id, redirect_uri, code_challenge, scope, resource, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    digest(code), grantId, userId, client.clientId, row.redirect_uri, row.code_challenge, scopes.join(" "), row.resource, now, iso(AUTH_CODE_TTL_S),
  );
  const u = new URL(row.redirect_uri);
  u.searchParams.set("code", code);
  if (row.state !== null) u.searchParams.set("state", row.state);
  u.searchParams.set("iss", issuer);
  return u.toString();
}

/** Une autorisation active par (compte, client) : reconnecter la même application met à jour ses portées. */
async function upsertGrant(userId: string, client: OAuthClient, redirectUri: string, scope: string, resource: string): Promise<string> {
  const host = (() => { try { return new URL(redirectUri).host; } catch { return null; } })();
  const existing = await authGet<{ id: string }>(
    `SELECT id FROM oauth_grants WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL`, userId, client.clientId,
  );
  if (existing) {
    await authRun(`UPDATE oauth_grants SET scope = ?, client_name = ?, client_host = ? WHERE id = ?`, scope, client.name, host, existing.id);
    return existing.id;
  }
  const id = newId("grant");
  await authRun(
    `INSERT INTO oauth_grants (id, user_id, client_id, client_name, client_host, scope, resource, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    id, userId, client.clientId, client.name, host, scope, resource, nowStr(),
  );
  return id;
}

// ─────────────────────────── point de jeton ───────────────────────────

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

/**
 * Identifie le client au point de jeton. Clients PUBLICS seulement (PKCE fait
 * foi) : le client_id vient du formulaire, ou d'un en-tête Basic que certains
 * clients envoient quand même (secret vide ou ignoré). Un en-tête illisible est
 * un refus d'authentification (401), jamais une erreur serveur.
 */
async function identifyClient(form: URLSearchParams, authorization: string | null, fetcher?: MetadataFetcher): Promise<OAuthClient> {
  let clientId = form.get("client_id");
  const basic = authorization?.match(/^Basic\s+(.+)$/i);
  if (basic) {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    try {
      clientId = decodeURIComponent(colon >= 0 ? decoded.slice(0, colon) : decoded);
    } catch {
      throw new OAuthError("invalid_client", "En-tête d'authentification illisible.", 401);
    }
  }
  const client = clientId ? await findClient(clientId, fetcher) : null;
  if (!client) throw new OAuthError("invalid_client", "Client inconnu.", 401);
  return client;
}

/** `family` = lignée (empreinte du code d'origine) : un rejeu ne révoque qu'elle, pas les autres appareils du compte. */
async function issueTokens(g: { grantId: string; family: string; userId: string; clientId: string; scope: string; resource: string }): Promise<TokenResponse> {
  const access = newSecret("at");
  const refresh = newSecret("rt");
  const now = nowStr();
  await authRun(`DELETE FROM oauth_tokens WHERE expires_at < ?`, nowStr(-86400_000));
  for (const [token, kind, ttl] of [[access, "access", ACCESS_TOKEN_TTL_S], [refresh, "refresh", REFRESH_TOKEN_TTL_S]] as const) {
    await authRun(
      `INSERT INTO oauth_tokens (token_hash, kind, family, grant_id, user_id, client_id, scope, resource, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      digest(token), kind, g.family, g.grantId, g.userId, g.clientId, g.scope, g.resource, now, iso(ttl),
    );
  }
  await authRun(`UPDATE oauth_grants SET last_used_at = ? WHERE id = ?`, now, g.grantId);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope: g.scope };
}

type CodeRow = { grant_id: string; user_id: string; client_id: string; redirect_uri: string; code_challenge: string; scope: string; resource: string };

/** POST /oauth/token — authorization_code (PKCE) ou refresh_token (rotation). */
export async function exchangeToken(
  form: URLSearchParams, authorization: string | null, mcpResource: string, fetcher?: MetadataFetcher,
): Promise<TokenResponse> {
  const grantType = form.get("grant_type");
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    throw new OAuthError("unsupported_grant_type", "Seuls authorization_code et refresh_token sont servis.");
  }
  const client = await identifyClient(form, authorization, fetcher);
  const rawResource = form.get("resource");
  if (rawResource !== null && canonicalResource(rawResource) !== canonicalResource(mcpResource)) {
    throw new OAuthError("invalid_target", "Ressource inconnue.");
  }
  return grantType === "authorization_code" ? redeemCode(form, client) : rotateRefresh(form, client);
}

async function redeemCode(form: URLSearchParams, client: OAuthClient): Promise<TokenResponse> {
  const code = form.get("code") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  const now = nowStr();
  // Consommé AVANT toute vérification : un code présenté deux fois ne sert jamais
  // deux fois, même si la première présentation échoue (RFC 6749 §4.1.2).
  const row = await authTx((tx) => tx.get<CodeRow>(
    `UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
     RETURNING grant_id, user_id, client_id, redirect_uri, code_challenge, scope, resource`,
    now, digest(code), now,
  ));
  if (!row) {
    // Code rejoué : les jetons émis à partir de CE code sont révoqués (RFC 6749 §4.1.2),
    // pas ceux des autres appareils du même compte (même autorisation, autre lignée).
    const replay = await authGet<{ code_hash: string }>(`SELECT code_hash FROM oauth_codes WHERE code_hash = ? AND used_at IS NOT NULL`, digest(code));
    if (replay) await revokeFamily(replay.code_hash);
    throw new OAuthError("invalid_grant", "Code d'autorisation invalide, expiré ou déjà utilisé.");
  }
  if (row.client_id !== client.clientId) throw new OAuthError("invalid_grant", "Ce code n'a pas été émis pour ce client.");
  const redirect = form.get("redirect_uri");
  if (redirect !== null && redirect !== row.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri différente de celle de la demande.");
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(pkceChallenge(verifier), row.code_challenge)) {
    throw new OAuthError("invalid_grant", "Vérification PKCE échouée.");
  }
  const grant = await authGet<{ revoked_at: string | null }>(`SELECT revoked_at FROM oauth_grants WHERE id = ?`, row.grant_id);
  if (!grant || grant.revoked_at) throw new OAuthError("invalid_grant", "Autorisation révoquée.");
  return issueTokens({ grantId: row.grant_id, family: digest(code), userId: row.user_id, clientId: row.client_id, scope: row.scope, resource: row.resource });
}

type TokenRow = { grant_id: string; family: string; user_id: string; client_id: string; scope: string; resource: string; kind: string; revoked_at: string | null; rotated_at: string | null; expires_at: string };

/**
 * Tolérance de rejeu d'un refresh (secondes, OAUTH_REFRESH_GRACE_S, défaut 30) :
 * un client qui renvoie son refresh après une coupure réseau — il n'a jamais
 * reçu la réponse — est servi au lieu d'être pris pour un voleur. Au-delà, un
 * refresh déjà tourné présenté à nouveau révoque sa lignée.
 */
function refreshGraceS(): number {
  const n = Number(process.env.OAUTH_REFRESH_GRACE_S);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 300) : 30;
}

async function rotateRefresh(form: URLSearchParams, client: OAuthClient): Promise<TokenResponse> {
  const token = form.get("refresh_token") ?? "";
  const now = nowStr();
  const hash = digest(token);
  const graceStart = nowStr(-refreshGraceS() * 1000);
  const row = await authTx((tx) => tx.get<TokenRow>(
    `UPDATE oauth_tokens SET rotated_at = COALESCE(rotated_at, ?)
      WHERE token_hash = ? AND kind = 'refresh' AND revoked_at IS NULL AND expires_at > ?
        AND (rotated_at IS NULL OR rotated_at > ?)
     RETURNING grant_id, family, user_id, client_id, scope, resource, kind, revoked_at, rotated_at, expires_at`,
    now, hash, now, graceStart,
  ));
  if (!row) {
    const seen = await authGet<TokenRow>(`SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'`, hash);
    // Refresh déjà tourné présenté hors tolérance : quelqu'un d'autre le détient — on coupe sa lignée.
    if (seen?.rotated_at) await revokeFamily(seen.family);
    throw new OAuthError("invalid_grant", "Jeton de rafraîchissement invalide, expiré ou déjà utilisé.");
  }
  if (row.client_id !== client.clientId) throw new OAuthError("invalid_grant", "Ce jeton n'a pas été émis pour ce client.");
  const grant = await authGet<{ revoked_at: string | null; scope: string }>(`SELECT revoked_at, scope FROM oauth_grants WHERE id = ?`, row.grant_id);
  if (!grant || grant.revoked_at) throw new OAuthError("invalid_grant", "Autorisation révoquée.");
  // L'autorisation fait foi : une portée retirée à la reconnexion (case « générer »
  // décochée) l'est aussi pour les jetons déjà émis. Une portée demandée ici ne
  // peut que RESTREINDRE encore.
  let scope = intersectScopes(row.scope, grant.scope);
  const asked = form.get("scope");
  if (asked) {
    const allowed = new Set(scope.split(" "));
    const wanted = asked.split(/\s+/).filter(Boolean);
    if (wanted.some((s) => !allowed.has(s))) throw new OAuthError("invalid_scope", "Portée plus large que l'autorisation d'origine.");
    scope = wanted.join(" ");
  }
  return issueTokens({ grantId: row.grant_id, family: row.family, userId: row.user_id, clientId: row.client_id, scope, resource: row.resource });
}

// ─────────────────────────── révocation ───────────────────────────

/** Révoque une lignée de jetons (issus d'un même code, rotations comprises). */
async function revokeFamily(family: string): Promise<void> {
  await authRun(`UPDATE oauth_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL`, nowStr(), family);
}

async function revokeGrantTokens(grantId: string): Promise<void> {
  const now = nowStr();
  await authRun(`UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`, now, grantId);
  await authRun(`UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, now, grantId);
}

/**
 * POST /oauth/revoke (RFC 7009). Révoquer un refresh coupe sa lignée (le client
 * se déconnecte) ; un jeton d'accès, seulement lui. Jeton inconnu : succès
 * silencieux (la RFC l'impose, et cela n'apprend rien à qui sonde).
 */
export async function revokeToken(form: URLSearchParams, authorization: string | null, fetcher?: MetadataFetcher): Promise<void> {
  const client = await identifyClient(form, authorization, fetcher);
  const hash = digest(form.get("token") ?? "");
  const row = await authGet<{ kind: string; family: string; client_id: string }>(
    `SELECT kind, family, client_id FROM oauth_tokens WHERE token_hash = ?`, hash,
  );
  if (!row || row.client_id !== client.clientId) return;
  if (row.kind === "refresh") await revokeFamily(row.family);
  else await authRun(`UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`, nowStr(), hash);
}

// ─────────────────────────── vérification (serveur MCP) ───────────────────────────

export type Principal = {
  userId: string;
  clientId: string;
  grantId: string;
  scopes: string[];
  /** Expiration du jeton, en secondes depuis l'époque. */
  expiresAt: number;
};

/**
 * Jeton d'accès → compte, ou null. Refusé s'il est inconnu, expiré, révoqué,
 * d'une autorisation révoquée, ou émis pour une AUTRE ressource que ce point MCP
 * (pas de jeton accepté « par erreur » d'audience — spec MCP, Token Audience Binding).
 */
export async function verifyAccessToken(token: string, mcpResource: string): Promise<Principal | null> {
  if (!token.startsWith("cx_at_")) return null;
  const now = nowStr();
  const row = await authGet<TokenRow & { grant_revoked: string | null; grant_scope: string }>(
    `SELECT t.grant_id, t.family, t.user_id, t.client_id, t.scope, t.resource, t.kind, t.revoked_at, t.rotated_at, t.expires_at,
            g.revoked_at AS grant_revoked, g.scope AS grant_scope
       FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
      WHERE t.token_hash = ? AND t.kind = 'access'`,
    digest(token),
  );
  if (!row || row.revoked_at || row.grant_revoked || row.expires_at <= now) return null;
  if (canonicalResource(row.resource) !== canonicalResource(mcpResource)) return null;
  return {
    // Portées du jeton bornées par celles de l'autorisation en vigueur (réduite à une reconnexion).
    userId: row.user_id, clientId: row.client_id, grantId: row.grant_id, scopes: intersectScopes(row.scope, row.grant_scope).split(" ").filter(Boolean),
    expiresAt: Math.floor(Date.parse(row.expires_at.replace(" ", "T") + "Z") / 1000),
  };
}

// ─────────────────────────── applications connectées ───────────────────────────

export type ConnectedApp = {
  id: string;
  name: string | null;
  host: string | null;
  scopes: string[];
  connectedAt: string;
  lastUsedAt: string | null;
};

/** Autorisations actives d'un compte, la plus récente d'abord. */
export async function listConnectedApps(userId: string): Promise<ConnectedApp[]> {
  const rows = await authAll<{ id: string; client_name: string | null; client_host: string | null; scope: string; created_at: string; last_used_at: string | null }>(
    `SELECT id, client_name, client_host, scope, created_at, last_used_at FROM oauth_grants
      WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    userId,
  );
  return rows.map((r) => ({
    id: r.id, name: r.client_name, host: r.client_host, scopes: r.scope.split(" ").filter(Boolean),
    connectedAt: r.created_at, lastUsedAt: r.last_used_at,
  }));
}

/** Révoque une autorisation du compte (et tous ses jetons). false = inconnue ou pas à ce compte. */
export async function revokeConnectedApp(userId: string, grantId: string): Promise<boolean> {
  const g = await authGet<{ id: string }>(`SELECT id FROM oauth_grants WHERE id = ? AND user_id = ? AND revoked_at IS NULL`, grantId, userId);
  if (!g) return false;
  await revokeGrantTokens(g.id);
  return true;
}

/** Marque l'usage d'une autorisation (au plus une écriture par minute et par autorisation). */
const lastTouch = new Map<string, number>();
export async function touchGrant(grantId: string): Promise<void> {
  const t = Date.now();
  if ((lastTouch.get(grantId) ?? 0) > t - 60_000) return;
  if (lastTouch.size > 10_000) lastTouch.clear();
  lastTouch.set(grantId, t);
  await authRun(`UPDATE oauth_grants SET last_used_at = ? WHERE id = ?`, nowStr(), grantId);
}
