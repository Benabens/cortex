import { calibrationSummary, recordFeedback, resolveExamMeta } from "@/lib/calibration";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET : récap « ce que j'ai appris de tes retours » (cours courant). */
export function GET(req: NextRequest) {
  useCourse(req);
  return NextResponse.json(calibrationSummary());
}

/** POST {examId?, topic?, archetype?, verdict, note?, score?} : enregistre un retour. */
export async function POST(req: NextRequest) {
  useCourse(req);
  const b = await req.json().catch(() => ({}));
  if (!b?.verdict) return NextResponse.json({ error: "verdict requis (too_easy|good|not_prof_style|wrong)." }, { status: 400 });
  // archétype/topic non fournis → les résoudre depuis l'exo généré (tag architect:<id>).
  let archetype = b.archetype ?? null;
  let topic = b.topic ?? null;
  if (b.examId && (!archetype || !topic)) {
    const meta = resolveExamMeta(Number(b.examId));
    archetype = archetype ?? meta.archetype;
    topic = topic ?? meta.topic;
  }
  const id = recordFeedback({
    examId: b.examId ?? null,
    topic,
    archetype,
    verdict: String(b.verdict),
    note: b.note ?? null,
    score: typeof b.score === "number" ? b.score : null,
  });
  return NextResponse.json({ ok: true, id, archetype, topic });
}
