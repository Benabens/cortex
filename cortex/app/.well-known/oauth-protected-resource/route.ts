import { oauthPreflight, protectedResourceMetadata } from "@/lib/oauth/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 9728 — racine, pour les clients qui ne dérivent pas le chemin de la ressource. */
export const GET = protectedResourceMetadata;
export const OPTIONS = oauthPreflight;
