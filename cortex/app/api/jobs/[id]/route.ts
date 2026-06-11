import { getJob, setJob } from "@/lib/jobs";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(Number(id));
  if (!job) return NextResponse.json({ error: "job introuvable" }, { status: 404 });
  return NextResponse.json(job);
}

/** Annulation : marque le job canceled ; le worker s'arrête à la prochaine étape. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(Number(id));
  if (!job) return NextResponse.json({ error: "job introuvable" }, { status: 404 });
  if (job.status !== "done" && job.status !== "error") setJob(Number(id), { status: "canceled", currentStep: "Annulé" });
  return NextResponse.json({ ok: true });
}
