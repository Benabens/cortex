import { cancelJob, getJob, jobEta } from "@/lib/jobs";
import { useCourseOr404 } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const { id } = await params;
  const job = await getJob(Number(id));
  if (!job) return NextResponse.json({ error: "job introuvable" }, { status: 404 });
  // Temps restant estimé (lib/eta) : affiché par le suivi, jamais bloquant.
  const eta = await jobEta(job).catch(() => null);
  return NextResponse.json({ ...job, eta: eta?.label ?? null });
}

/** Annulation (alias historique de /cancel) : tue réellement le worker et ses enfants. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const { id } = await params;
  const job = await cancelJob(Number(id));
  if (!job) return NextResponse.json({ error: "job introuvable" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
