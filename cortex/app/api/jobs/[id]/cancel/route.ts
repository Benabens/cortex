import { cancelJob } from "@/lib/jobs";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Annulation RÉELLE : tue le worker (et ses enfants claude/tectonic), nettoie les artefacts partiels. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = cancelJob(Number(id));
  if (!job) return NextResponse.json({ error: "job introuvable" }, { status: 404 });
  return NextResponse.json({ ok: true, job });
}
