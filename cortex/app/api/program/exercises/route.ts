import { exercisesForTopic } from "@/lib/exam-index";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** V11 — les exos INDEXÉS (de l'index exo-par-exo) rattachés à un type, avec leurs 2 deep-links. */
export async function GET(req: NextRequest) {
  useCourse(req);
  const id = Number(req.nextUrl.searchParams.get("topic"));
  if (!id) return NextResponse.json({ error: "topic manquant" }, { status: 400 });
  return NextResponse.json({ exercises: await exercisesForTopic(id) });
}
