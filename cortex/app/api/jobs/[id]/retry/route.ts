import { creditsGate } from "@/lib/billing/credits";
import { generationGate } from "@/lib/billing/guards";
import { ReservationRefused, getJob, retryJob } from "@/lib/jobs";
import { requireCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Relance un job échoué/zombie : recrée un job de même type+target et redémarre le worker.
 * Un retry est une NOUVELLE génération → mêmes garde-fous
 * (quota/jour + solde de crédits) que les routes generate. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  const { id } = await params;
  const old = await getJob(Number(id));
  if (old && old.type !== "ingest") {
    const gate = (await generationGate("gen")) ?? (await creditsGate(old.type));
    if (gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
  }
  let job;
  try {
    job = await retryJob(Number(id), course);
  } catch (e) {
    if (e instanceof ReservationRefused) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  if (!job) return NextResponse.json({ error: "job introuvable" }, { status: 404 });
  return NextResponse.json({ ok: true, jobId: job.id, job });
}
