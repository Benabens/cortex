import { oauthPreflight, revokeEndpoint } from "@/lib/oauth/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 7009 — révocation d'un jeton par le client. */
export const POST = revokeEndpoint;
export const OPTIONS = oauthPreflight;
