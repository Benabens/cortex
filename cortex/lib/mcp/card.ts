import { issuerFor } from "@/lib/oauth/config";
import { serverCard } from "./identity";

/**
 * CARTE DU SERVEUR (SEP-2127) — servie à `/mcp/server-card` et à
 * `/.well-known/mcp/server-card.json`, sans session ni jeton : un annuaire ou un
 * client la lit AVANT de se connecter. Elle suit l'activation du connecteur
 * (MCP_ENABLED) comme les métadonnées OAuth : une carte qui annonce un point /mcp
 * répondant 404 contredirait le SEP (« cohérente avec le comportement réel »).
 * Document public et sans donnée de compte : CORS ouvert (`*`, sans cookie), cache
 * d'une heure.
 */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
};

export function serverCardResponse(req: Request): Response {
  const issuer = issuerFor(req);
  if (!issuer) return Response.json({ error: "not_found" }, { status: 404 });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  return Response.json(serverCard(issuer), { headers: { ...CORS, "cache-control": "public, max-age=3600" } });
}
