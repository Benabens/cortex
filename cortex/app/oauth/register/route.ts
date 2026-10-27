import { oauthPreflight, registerEndpoint } from "@/lib/oauth/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 7591 — enregistrement dynamique d'un client MCP. */
export const POST = registerEndpoint;
export const OPTIONS = oauthPreflight;
