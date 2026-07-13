import { q } from "@/db/q";
import { llmAvailable } from "@/lib/llm";
import { sandboxAvailable } from "@/lib/sandbox-exec";
import { texAvailable } from "@/lib/exam-latex";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/health (Phase E) — sonde de disponibilité, PUBLIQUE (proxy.ts la laisse
 * passer). Rapide, sans secret : DB joignable, moteur LLM prêt, sandbox et LaTeX
 * présents. status 200 si la DB répond, 503 sinon (readiness).
 */
export async function GET() {
  let db = false;
  try { await q.get(`SELECT 1 AS ok`); db = true; } catch { db = false; }
  const body = {
    status: db ? "ok" : "degraded",
    driver: q.dialect,
    checks: {
      db,
      llm: llmAvailable(),
      sandbox: sandboxAvailable(),
      latex: texAvailable(),
    },
    uptimeSec: Math.round(process.uptime()),
  };
  return NextResponse.json(body, { status: db ? 200 : 503 });
}
