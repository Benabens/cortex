import { activeJob, listJobs, pumpQueuedJobs } from "@/lib/jobs";
import { useCourseOr404 } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const type = req.nextUrl.searchParams.get("type") as "exam" | "exercise" | null;
  void pumpQueuedJobs().catch(() => {}); // relance les jobs re-mis en file (fire-and-forget)
  return NextResponse.json({ active: await activeJob(type ?? undefined), recent: await listJobs(8) });
}
