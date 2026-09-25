import { LlmError } from "@/lib/llm";
import { mineConversation } from "@/lib/conversation-mining";
import { useCourseOr404 } from "@/lib/req";
import { logLoopRoute } from "@/lib/req-log";
import { createWeakness, listWeaknesses } from "@/lib/weaknesses";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;

/**
 * Importer une DISCUSSION → faiblesses classées.
 * Analyse la conversation (via le fournisseur LLM configuré), crée des faiblesses structurées (source='conversation',
 * thème, gravité, extrait), auto-liées au corpus du cours. Renvoie les faiblesses créées + la liste.
 */
export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    return await handlePOST(req);
  } finally {
    logLoopRoute(req, "weakness-mine", t0);
  }
}

async function handlePOST(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  // Appel LLM INLINE → quota d'assistance par user/jour
  // (DAILY_ASSIST_QUOTA, no-op sans env), compté à la tentative.
  {
    const { generationGate, recordGeneration } = await import("@/lib/billing/guards");
    const { creditsGate } = await import("@/lib/billing/credits");
    // Quota d'assistance ET solde : ces appels coûtent de l'argent au même
    // titre qu'une génération (sans ça, un solde à 0 pouvait encore consommer
    // l'API en boucle via drill/check-solution/analyse).
    const gate = (await generationGate("assist")) ?? (await creditsGate("assist"));
    if (gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
    await recordGeneration("assist", "weakness-mine");
  }
  const { text } = await req.json().catch(() => ({ text: "" }));
  const t = String(text ?? "").trim();
  if (t.length < 40) return NextResponse.json({ error: "Colle une discussion (au moins quelques échanges)." }, { status: 400 });

  try {
    const mined = await mineConversation(t);
    if (!mined.length) return NextResponse.json({ created: 0, weaknesses: await listWeaknesses(), note: "Aucune faiblesse claire détectée dans cette discussion." });
    for (const m of mined) {
      await createWeakness({
        topic: m.topic,
        description: `${m.concept}${m.excerpt ? `\n\n« ${m.excerpt} »` : ""}`,
        severity: m.severity,
        source: "conversation",
        theme: m.theme,
        analyzed: true, // déjà structuré par l'IA
      });
    }
    return NextResponse.json({ created: mined.length, mined, weaknesses: await listWeaknesses() });
  } catch (e) {
    if (e instanceof LlmError && e.code === "UNAVAILABLE") {
      return NextResponse.json({ error: "Le moteur LLM est injoignable — réessaie plus tard." }, { status: 503 });
    }
    return NextResponse.json({ error: String((e as Error)?.message ?? e) }, { status: 500 });
  }
}
