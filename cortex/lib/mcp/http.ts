import {
  OAuthError, OAuthErrorCode, bearerAuthChallengeResponse, createMcpHandler, originValidationResponse, verifyBearerToken,
  type AuthInfo, type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { log } from "@/lib/metrics";
import { SCOPE_READ, SUPPORTED_SCOPES, issuerFor, resourceFor } from "@/lib/oauth/config";
import { allowedOriginHosts, corsHeaders } from "@/lib/oauth/cors";
import { touchGrant, verifyAccessToken } from "@/lib/oauth/server";
import { buildServer } from "./server";

/**
 * POINT MCP — `POST /mcp` (Streamable HTTP, sans état, ères 2026-07-28 et 2025).
 *
 * Ordre des gardes, avant que le SDK ne lise quoi que ce soit :
 *  1. MCP activé sur l'instance (sinon 404) ;
 *  2. `Origin` présente et inconnue → 403 (DNS rebinding ; une requête serveur
 *     à serveur, sans Origin, passe) ;
 *  3. jeton Bearer vérifié (audience = ce point /mcp) → 401 + WWW-Authenticate
 *     qui désigne les métadonnées RFC 9728 et les portées à demander ;
 *  4. limite de débit par compte (en mémoire : conteneur unique, cf. ARCHITECTURE) ;
 *  5. SDK : une instance McpServer par requête, au nom du compte du jeton.
 */

const MAX_BODY_BYTES = 256 * 1024;

const CORS_EXTRA = {
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-protocol-version",
  "access-control-max-age": "600",
};

function withCors(req: Request, issuer: string, res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(req, issuer, CORS_EXTRA))) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Débit par compte et par minute (fenêtre fixe). MCP_RATE_LIMIT_PER_MIN, défaut 120 ; « unlimited » lève. */
const buckets = new Map<string, { n: number; resetAt: number }>();
function rateCap(): number | null {
  const raw = process.env.MCP_RATE_LIMIT_PER_MIN;
  if (raw && /^(unlimited|none|off|-1)$/i.test(raw.trim())) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120;
}
function overRate(userId: string): boolean {
  const cap = rateCap();
  if (cap === null) return false;
  const now = Date.now();
  const b = buckets.get(userId);
  if (!b || now >= b.resetAt) {
    if (buckets.size > 10_000) buckets.clear();
    buckets.set(userId, { n: 1, resetAt: now + 60_000 });
    return false;
  }
  b.n += 1;
  return b.n > cap;
}

let _handler: McpHttpHandler | null = null;
function handler(): McpHttpHandler {
  if (!_handler) {
    _handler = createMcpHandler(
      ({ era, authInfo }) => buildServer({ era, appOrigin: String((authInfo?.extra as { appOrigin?: string } | undefined)?.appOrigin ?? "") }),
      {
        responseMode: "auto",
        maxRequestBodySize: MAX_BODY_BYTES,
        onerror: (e) => log("warn", "mcp.transport_error", { name: e.name, message: String(e.message).slice(0, 160) }),
      },
    );
  }
  return _handler;
}

export async function handleMcp(req: Request): Promise<Response> {
  const issuer = issuerFor(req);
  if (!issuer) return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req, issuer, CORS_EXTRA) });

  const badOrigin = originValidationResponse(req, allowedOriginHosts(issuer));
  if (badOrigin) return withCors(req, issuer, badOrigin);

  const resource = resourceFor(issuer);
  const resourceMetadataUrl = `${issuer}/.well-known/oauth-protected-resource/mcp`;
  let authInfo: AuthInfo;
  try {
    authInfo = await verifyBearerToken(req.headers.get("authorization"), {
      verifier: {
        async verifyAccessToken(token: string): Promise<AuthInfo> {
          const p = await verifyAccessToken(token, resource);
          if (!p) throw new OAuthError(OAuthErrorCode.InvalidToken, "Jeton invalide, expiré ou révoqué.");
          return {
            token, clientId: p.clientId, scopes: p.scopes, expiresAt: p.expiresAt, resource: new URL(resource),
            extra: { userId: p.userId, grantId: p.grantId, appOrigin: issuer },
          };
        },
      },
      expectedResource: new URL(resource),
      requiredScopes: [SCOPE_READ],
      resourceMetadataUrl,
    });
  } catch (e) {
    // 401 : le client doit (re)lancer OAuth — on lui indique TOUTES les portées, pour une seule connexion.
    return withCors(req, issuer, bearerAuthChallengeResponse(e, { requiredScopes: [...SUPPORTED_SCOPES], resourceMetadataUrl }));
  }

  const { userId, grantId } = authInfo.extra as { userId: string; grantId: string };
  if (overRate(userId)) {
    return withCors(req, issuer, Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Trop de requêtes MCP pour ce compte — réessaie dans une minute." } },
      { status: 429, headers: { "retry-after": "60" } },
    ));
  }
  void touchGrant(grantId).catch(() => {});
  return withCors(req, issuer, await handler().fetch(req, { authInfo }));
}
