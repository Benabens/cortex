import { apiError } from "@/lib/i18n/api-error";
import { recordScore } from "@/lib/program";
import { useCourseOr404 } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";
import { readJson, withBodyLimit } from "@/lib/upload-limit";
import { LlmError, llmUserError } from "@/lib/llm";
import { UserFacingError } from "@/lib/i18n/user-error";

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
    return apiError(req, "topic_and_score_required", 400);
  try {
    const res = await recordScore(topicId, score, body.examId ? Number(body.examId) : undefined);
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    if (e instanceof UserFacingError) return apiError(req, e);
    if (e instanceof LlmError) return apiError(req, llmUserError(e), 400);
    const detail = e instanceof Error ? e.message : String(e);
    return apiError(req, { code: "score_record_failed", params: { detail } }, 400);
  }
})
