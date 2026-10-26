import { oauthPreflight, protectedResourceMetadata } from "@/lib/oauth/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 9728 — métadonnées de la ressource /mcp (adresse annoncée dans WWW-Authenticate). */
export const GET = protectedResourceMetadata;
export const OPTIONS = oauthPreflight;
