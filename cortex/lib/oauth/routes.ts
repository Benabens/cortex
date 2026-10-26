import { NextResponse } from "next/server";
import { log } from "@/lib/metrics";
import { PayloadTooLarge, readJson, readText } from "@/lib/upload-limit";
import { ClientRegistrationError, registerClient } from "./clients";
import { SUPPORTED_SCOPES, issuerFor, resourceFor } from "./config";
import { OAuthError, createConsentTicket, decideConsent, exchangeToken, revokeToken, validateAuthorizeRequest } from "./server";

/**
 * POINTS HTTP PUBLICS du serveur d'autorisation (montés par app/.well-known/* et
 * app/oauth/*). Lus par des clients MCP, parfois depuis un navigateur (inspecteur
 * MCP) : CORS ouvert — sans danger ici, aucun cookie n'y est lu, tout passe par
 * le corps de la requête ou un jeton Bearer. Réponses jamais mises en cache.
 */

const OAUTH_BODY_MAX = 16 * 1024;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "600",
};

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { ...CORS, "cache-control": "no-store", pragma: "no-cache" } });
}

function notFound(): NextResponse {
  return json({ error: "not_found" }, 404);
}

/** Pré-vol CORS des points OAuth. */
export function oauthPreflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

function oauthError(e: OAuthError): NextResponse {
  const res = json({ error: e.code, error_description: e.description }, e.status);
  if (e.status === 401) res.headers.set("www-authenticate", `Basic realm="cortex"`);
  return res;
}

/** RFC 8414 — métadonnées du serveur d'autorisation. */
export function authorizationServerMetadata(req: Request): NextResponse {
  const issuer = issuerFor(req);
  if (!issuer) return notFound();
  return json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [...SUPPORTED_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  });
}

/** RFC 9728 — métadonnées de la ressource protégée (le point MCP). */
export function protectedResourceMetadata(req: Request): NextResponse {
  const issuer = issuerFor(req);
  if (!issuer) return notFound();
  return json({
    resource: resourceFor(issuer),
    authorization_servers: [issuer],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Cortex",
  });
}

/** RFC 7591 — enregistrement dynamique d'un client. */
export async function registerEndpoint(req: Request): Promise<NextResponse> {
  if (!issuerFor(req)) return notFound();
  let meta: unknown;
  try { meta = await readJson(req, null, OAUTH_BODY_MAX); } catch (e) {
    if (e instanceof PayloadTooLarge) return json({ error: "invalid_client_metadata", error_description: "Corps trop volumineux." }, 413);
    throw e;
  }
  try {
    const { client, secret, issuedAt } = await registerClient(meta);
    log("info", "oauth.client_registered", { kind: "dcr", method: client.authMethod });
    return json({
      client_id: client.clientId,
      client_id_issued_at: issuedAt,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: client.name ?? undefined,
      client_uri: client.uri ?? undefined,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: client.authMethod,
    }, 201);
  } catch (e) {
    if (e instanceof ClientRegistrationError) return json({ error: e.code, error_description: e.message }, 400);
    throw e;
  }
}

async function readForm(req: Request): Promise<URLSearchParams | NextResponse> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return json({ error: "invalid_request", error_description: "Corps application/x-www-form-urlencoded attendu." }, 400);
  }
  try { return new URLSearchParams(await readText(req, OAUTH_BODY_MAX)); } catch (e) {
    if (e instanceof PayloadTooLarge) return json({ error: "invalid_request", error_description: "Corps trop volumineux." }, 413);
    throw e;
  }
}

/** POST /oauth/token. */
export async function tokenEndpoint(req: Request): Promise<NextResponse> {
  const issuer = issuerFor(req);
  if (!issuer) return notFound();
  const form = await readForm(req);
  if (form instanceof NextResponse) return form;
  try {
    const tokens = await exchangeToken(form, req.headers.get("authorization"), resourceFor(issuer));
    return json(tokens);
  } catch (e) {
    if (e instanceof OAuthError) {
      log("info", "oauth.token_refused", { grant: form.get("grant_type") ?? "", code: e.code });
      return oauthError(e);
    }
    throw e;
  }
}

/** POST /oauth/revoke (RFC 7009) : 200 même pour un jeton inconnu. */
export async function revokeEndpoint(req: Request): Promise<NextResponse> {
  if (!issuerFor(req)) return notFound();
  const form = await readForm(req);
  if (form instanceof NextResponse) return form;
  try {
    await revokeToken(form, req.headers.get("authorization"));
    return new NextResponse(null, { status: 200, headers: { ...CORS, "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof OAuthError) return oauthError(e);
    throw e;
  }
}

/**
 * POST /oauth/authorize/decision — réponse de la personne à l'écran de
 * consentement. Derrière la session de l'app (proxy.ts) ; l'identité vient du
 * contexte posé par le proxy, jamais du formulaire. Défense CSRF en trois
 * couches : cookie de session SameSite=Lax (absent d'un POST intersite),
 * en-tête Origin = l'app elle-même, et ticket opaque lié à CE compte.
 */
export async function consentDecisionEndpoint(req: Request, userId: string): Promise<NextResponse> {
  const issuer = issuerFor(req);
  if (!issuer) return notFound();
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== issuer && origin !== new URL(req.url).origin) {
    return NextResponse.json({ error: "Origine refusée." }, { status: 403 });
  }
  let form: URLSearchParams;
  try { form = new URLSearchParams(await readText(req, OAUTH_BODY_MAX)); } catch (e) {
    if (e instanceof PayloadTooLarge) return NextResponse.json({ error: "Corps trop volumineux." }, { status: 413 });
    throw e;
  }
  const ticket = form.get("ticket") ?? "";
  const approve = form.get("decision") === "approve";
  try {
    const target = await decideConsent(userId, ticket, approve, issuer, form.get("generate") === "on");
    log("info", "oauth.consent", { approved: approve });
    return NextResponse.redirect(target, 303);
  } catch (e) {
    if (e instanceof OAuthError) {
      const back = new URL("/oauth/authorize", issuer);
      back.searchParams.set("error", e.description);
      return NextResponse.redirect(back, 303);
    }
    throw e;
  }
}

export type ConsentView =
  | { kind: "redirect"; url: string }
  | { kind: "error"; message: string }
  | { kind: "consent"; ticket: string; clientName: string | null; clientHost: string; verifiedDomain: boolean; scopes: string[] };

/**
 * GET /oauth/authorize (page de consentement) : valide la demande pour le compte
 * connecté et prépare l'écran. La page ne fait qu'afficher ce que rend cette fonction.
 */
export async function prepareConsent(req: Request, params: URLSearchParams, userId: string): Promise<ConsentView> {
  const issuer = issuerFor(req);
  if (!issuer) return { kind: "error", message: "La connexion d'applications n'est pas activée sur cette instance de Cortex." };
  const shown = params.get("error");
  if (shown && !params.get("client_id")) return { kind: "error", message: shown.slice(0, 300) };
  const v = await validateAuthorizeRequest(params, issuer, resourceFor(issuer));
  if (!v.ok) return "redirect" in v ? { kind: "redirect", url: v.redirect } : { kind: "error", message: v.display };
  const ticket = await createConsentTicket(userId, v.request);
  const c = v.request.client;
  return {
    kind: "consent",
    ticket,
    clientName: c.name,
    clientHost: new URL(v.request.redirectUri).host,
    // CIMD : l'identité du client est un domaine qu'il contrôle (son client_id) ; DCR : un nom déclaré.
    verifiedDomain: c.kind === "cimd",
    scopes: v.request.scopes,
  };
}
