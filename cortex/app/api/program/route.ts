import { coverageNext, nextTopic, programOverview } from "@/lib/program";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tableau de bord « Programme & Maîtrise » : types + maîtrise + couverture + stats + prochains. */
export async function GET(req: NextRequest) {
  useCourse(req);
  const { topics, chapters, planOk, stats } = await programOverview();
  return NextResponse.json({ topics, chapters, planOk, stats, next: await nextTopic(), coverNext: await coverageNext() });
}
