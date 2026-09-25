import { LlmError } from "@/lib/llm";
import { generateDrill } from "@/lib/drill";
import { useCourse } from "@/lib/req";
import { logLoopRoute } from "@/lib/req-log";
import { q } from "@/db/q";
import { dueConcepts } from "@/lib/schedule";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;

export async function GET(req: NextRequest) {
  useCourse(req);
  const weaknesses = (await q.all<{ topic: string }>(`SELECT topic FROM weaknesses ORDER BY severity DESC LIMIT 12`))
    .map((w) => w.topic)
    .filter((t) => t && t !== "(à analyser)");
  return NextResponse.json({ due: await dueConcepts(15), weaknesses });
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  useCourse(req);
  try {
    // Appel LLM INLINE → quota d'assistance par user/jour
    // (DAILY_ASSIST_QUOTA) + limite de débit par minute, compté à la tentative.
    {
      const { generationGate, recordGeneration } = await import("@/lib/billing/guards");
      const { creditsGate } = await import("@/lib/billing/credits");
      // Quota d'assistance ET solde : ces appels coûtent de l'argent au même
      // titre qu'une génération (sans ça, un solde à 0 pouvait encore consommer
      // l'API en boucle via drill/check-solution/analyse).
      const gate = (await generationGate("assist")) ?? (await creditsGate("assist"));
      if (gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
      await recordGeneration("assist", "drill");
    }
    const { concept } = await req.json().catch(() => ({ concept: "" }));
    const c = String(concept ?? "").trim();
    if (!c) return NextResponse.json({ error: "concept manquant" }, { status: 400 });
    try {
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
}
