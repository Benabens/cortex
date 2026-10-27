import { handleMcp } from "@/lib/mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Un appel d'assistance (drill, correction) peut durer jusqu'à ~4 min.
export const maxDuration = 300;

/**
 * Point MCP de Cortex (Streamable HTTP, sans état) — docs/MCP.md. Public au
 * proxy : l'authentification est le jeton OAuth Bearer, vérifié par handleMcp.
 */
export const POST = handleMcp;
export const GET = handleMcp;
export const DELETE = handleMcp;
export const OPTIONS = handleMcp;
