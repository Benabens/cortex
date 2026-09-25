import { exercisesForTopic } from "@/lib/exam-index";
import { useCourseOr404 } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Les exos INDEXÉS (de l'index exo-par-exo) rattachés à un type, avec leurs 2 deep-links. */
export async function GET(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const id = Number(req.nextUrl.searchParams.get("topic"));
  if (!id) return NextResponse.json({ error: "topic manquant" }, { status: 400 });
  return NextResponse.json({ exercises: await exercisesForTopic(id) });
}
