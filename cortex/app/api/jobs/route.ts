import { activeJob, listJobs } from "@/lib/jobs";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type") as "exam" | "exercise" | null;
  return NextResponse.json({ active: activeJob(type ?? undefined), recent: listJobs(8) });
}
