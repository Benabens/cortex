import { oauthPreflight, tokenEndpoint } from "@/lib/oauth/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Point de jeton OAuth 2.1 (code + PKCE, refresh tournant). */
export const POST = tokenEndpoint;
export const OPTIONS = oauthPreflight;
