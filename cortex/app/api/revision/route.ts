import { sqlite } from "@/db/client";
import { bankQuestions, bankStats, ensureRevisionSchema, loadRevisionJson, planQuestions, planStats } from "@/lib/revision";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Révision — banque exhaustive (QCM/ouvertes triées) + parcours généré. Source de vérité : la DB du
 * cours si elle est peuplée, SINON le JSON committé `data/<course>/revision-<course>.json` (portable :
 * un simple `git pull` chez Ben affiche la page déjà remplie, sans rebuild).
 */
export function GET(req: NextRequest) {
  const course = useCourse(req);
  ensureRevisionSchema();
  const n = (sqlite.prepare(`SELECT count(*) n FROM bank_questions`).get() as { n: number }).n;
  if (n > 0) {
    return NextResponse.json({
      course, source: "db",
      bank: { stats: bankStats(), qcm: bankQuestions("qcm"), open: bankQuestions("open") },
      plan: { stats: planStats(), questions: planQuestions() },
    });
  }
  const json = loadRevisionJson(course);
  if (json) return NextResponse.json({ ...json, source: "json" });
  return NextResponse.json({ course, source: "empty", bank: { stats: { qcm: 0, open: 0, byTopic: [] }, qcm: [], open: [] }, plan: { stats: { qcm: 0, open: 0, topics: 0 }, questions: [] } });
}
