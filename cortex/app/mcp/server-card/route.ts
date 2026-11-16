import { serverCardResponse } from "@/lib/mcp/card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Carte du serveur MCP (SEP-2127), à l'emplacement recommandé `<url MCP>/server-card`. */
export const GET = serverCardResponse;
export const OPTIONS = serverCardResponse;
