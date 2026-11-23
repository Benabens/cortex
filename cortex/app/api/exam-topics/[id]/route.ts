import { NextResponse } from "next/server";
import { freeToolEnabled } from "@/lib/exam-topics/config";
import { getRun } from "@/lib/exam-topics/runs";
import { apiError } from "@/lib/i18n/api-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Statut ou résultat public d'une analyse de l'outil gratuit (jamais le texte des annales). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!freeToolEnabled()) return apiError(req, "exam_topics_not_found", 404);
  const run = await getRun((await ctx.params).id);
  if (!run) return apiError(req, "exam_topics_not_found", 404);
  return NextResponse.json(run, { headers: { "cache-control": "no-store" } });
}
