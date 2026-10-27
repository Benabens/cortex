import { authorizationServerMetadata, oauthPreflight } from "@/lib/oauth/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 8414 — métadonnées du serveur d'autorisation du connecteur MCP (docs/MCP.md). */
export const GET = authorizationServerMetadata;
export const OPTIONS = oauthPreflight;
