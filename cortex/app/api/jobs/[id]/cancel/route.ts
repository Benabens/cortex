import { cancelJob } from "@/lib/jobs";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Annulation RÉELLE : tue le worker (et ses enfants claude/tectonic), nettoie les artefacts partiels. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  useCourse(req);
  const { id } = await params;
  const job = cancelJob(Number(id));
  if (!job) return NextResponse.json({ error: "job introuvable" }, { status: 404 });
  return NextResponse.json({ ok: true, job });
}
