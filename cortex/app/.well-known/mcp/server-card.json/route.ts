import { serverCardResponse } from "@/lib/mcp/card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Carte du serveur MCP (SEP-2127), au chemin que cherchent les outils de découverte. */
export const GET = serverCardResponse;
export const OPTIONS = serverCardResponse;
