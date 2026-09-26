import { recordScore } from "@/lib/program";
import { useCourseOr404 } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";
import { readJson, withBodyLimit } from "@/lib/upload-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Note 0-10 sur un type : met à jour la maîtrise lissée + la répétition espacée
 * (courbe de l'oubli). Score ≤ 3 → renforce une faiblesse. Renvoie le type + les stats à jour.
 */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const body = await readJson(req, ({}));
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
})
