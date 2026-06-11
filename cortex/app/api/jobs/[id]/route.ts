import { cancelJob, getJob } from "@/lib/jobs";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  useCourse(req);
  const { id } = await params;
  const job = getJob(Number(id));
  if (!job) return NextResponse.json({ error: "job introuvable" }, { status: 404 });
  return NextResponse.json(job);
}

/** Annulation (alias historique de /cancel) : tue réellement le worker et ses enfants. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  useCourse(req);
  const { id } = await params;
  const job = cancelJob(Number(id));
  if (!job) return NextResponse.json({ error: "job introuvable" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
