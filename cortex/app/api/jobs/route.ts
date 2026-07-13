import { activeJob, listJobs, pumpQueuedJobs } from "@/lib/jobs";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  useCourse(req);
  const type = req.nextUrl.searchParams.get("type") as "exam" | "exercise" | null;
  void pumpQueuedJobs().catch(() => {}); // Phase C : relance les jobs re-mis en file (fire-and-forget)
  return NextResponse.json({ active: await activeJob(type ?? undefined), recent: await listJobs(8) });
}
