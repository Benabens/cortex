import { retryJob } from "@/lib/jobs";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** V8 — relance un job échoué/zombie : recrée un job de même type+target et redémarre le worker. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const course = useCourse(req);
  const { id } = await params;
  const job = await retryJob(Number(id), course);
  if (!job) return NextResponse.json({ error: "job introuvable" }, { status: 404 });
  return NextResponse.json({ ok: true, jobId: job.id, job });
}
