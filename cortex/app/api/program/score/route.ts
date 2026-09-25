import { recordScore } from "@/lib/program";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Note 0-10 sur un type : met à jour la maîtrise lissée + la répétition espacée
 * (courbe de l'oubli). Score ≤ 3 → renforce une faiblesse. Renvoie le type + les stats à jour.
 */
export async function POST(req: NextRequest) {
  useCourse(req);
  const body = await req.json().catch(() => ({}));
  const topicId = Number(body.topicId);
  const score = Number(body.score);
  if (!topicId || Number.isNaN(score) || score < 0 || score > 10)
    return NextResponse.json({ error: "Fournis topicId et un score 0-10." }, { status: 400 });
  try {
    const res = await recordScore(topicId, score, body.examId ? Number(body.examId) : undefined);
    return NextResponse.json({ ok: true, ...res });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 400 });
  }
}
