import { LlmError } from "@/lib/llm";
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
    if (!c) return NextResponse.json({ error: "concept manquant" }, { status: 400 });
    const tooLong = fieldTooLong("concept", c);
    if (tooLong) return tooLong;
    try {
      // Réservation atomique (rafale, quota du jour, solde) DÉBITÉE juste avant
      // l'appel au modèle, APRÈS validation de la demande : 0,1 crédit, non remboursé.
      const gate = await (await import("@/lib/billing/reserve")).assistGate("drill");
      if (gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
      const drill = await generateDrill(c);
      return NextResponse.json({ ok: true, drill });
    } catch (e: unknown) {
      const err = e as LlmError;
      const status = err.code === "UNAVAILABLE" || err.code === "SPEND_CAP" || err.code === "QUOTA" || err.code === "CREDITS" ? 503 : 502;
      return NextResponse.json({ error: err.message ?? String(e), code: err.code }, { status });
    }
  } finally {
    logLoopRoute(req, "drill", t0);
  }
})
