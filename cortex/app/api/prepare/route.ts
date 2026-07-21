import { activeJob, createJobExclusive, startWorker } from "@/lib/jobs";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * V10 — ONBOARDING/préparation d'un cours DEPUIS L'UI (plus seulement en CLI). POST → job 'prepare'
 * (ingestion contenu+annales → détection du format → blueprint), avec progression suivie par l'UI.
 */
export async function POST(req: NextRequest) {
  const course = useCourse(req);
  const existing = await activeJob("prepare");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true });
  // Déploiement v1 : la préparation d'un cours fait de la VISION LLM sur les
  // annales (coûteux) → quota + crédits comme toute génération.
  {
    const { generationGate } = await import("@/lib/billing/guards");
    const { creditsGate } = await import("@/lib/billing/credits");
    const gate = (await generationGate("gen")) ?? (await creditsGate("prepare"));
    if (gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
  }
  const { id: jobId } = await createJobExclusive("prepare");
  try { await startWorker(jobId, course); }
  catch (e: any) { return NextResponse.json({ error: `worker : ${e?.message ?? e}` }, { status: 500 }); }
  return NextResponse.json({ ok: true, jobId });
}
