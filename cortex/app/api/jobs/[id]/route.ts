import { cancelJob, getJob } from "@/lib/jobs";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(Number(id));
  if (!job) return NextResponse.json({ error: "job introuvable" }, { status: 404 });
  return NextResponse.json(job);
}

/** Annulation (alias historique de /cancel) : tue réellement le worker et ses enfants. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = cancelJob(Number(id));
  if (!job) return NextResponse.json({ error: "job introuvable" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
