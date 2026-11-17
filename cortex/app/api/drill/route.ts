import { apiError } from "@/lib/i18n/api-error";
import { LlmError, OWN_LLM_CODES, llmUserError } from "@/lib/llm";
import { generateDrill } from "@/lib/drill";
import { useCourseOr404 } from "@/lib/req";
import { logLoopRoute } from "@/lib/req-log";
import { q } from "@/db/q";
import { dueConcepts } from "@/lib/schedule";
import { NextRequest, NextResponse } from "next/server";
import { readJson, withBodyLimit } from "@/lib/upload-limit";
import { fieldTooLong } from "@/lib/field-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;

export async function GET(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const weaknesses = (await q.all<{ topic: string }>(`SELECT topic FROM weaknesses ORDER BY severity DESC LIMIT 12`))
    .map((w) => w.topic)
    .filter((t) => t && t !== "(à analyser)");
  return NextResponse.json({ due: await dueConcepts(15), weaknesses });
}

export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const t0 = Date.now();
  const denied = useCourseOr404(req);
  if (denied) return denied;
  try {
    const { concept } = await readJson(req, ({ concept: "" }));
    const c = String(concept ?? "").trim();
    if (!c) return apiError(req, "concept_missing", 400);
    const tooLong = fieldTooLong(req, "concept", c);
    if (tooLong) return tooLong;
    try {
      // Réservation atomique (rafale, quota du jour, solde) DÉBITÉE juste avant
      // l'appel au modèle, APRÈS validation de la demande : 0,3 crédit, rendu seulement si
      // l'appel n'est pas parti ou si la réponse est restée illisible (lib/billing/reserve).
      const { assistCall } = await import("@/lib/billing/reserve");
      const drill = await assistCall("drill", () => generateDrill(c));
      return NextResponse.json({ ok: true, drill });
    } catch (e: unknown) {
      const { AssistRefused } = await import("@/lib/billing/reserve");
      if (e instanceof AssistRefused) return apiError(req, e, e.status);
      const err = e as LlmError;
      const status = err.code && OWN_LLM_CODES.has(err.code) ? 503 : 502;
      // Jamais le texte brut du fournisseur : une cause lisible (lib/llm/errors).
      return apiError(req, llmUserError(e), status, { llmCode: err.code });
    }
  } finally {
    logLoopRoute(req, "drill", t0);
  }
})
