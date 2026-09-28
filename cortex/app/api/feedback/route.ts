import { calibrationSummary, recordFeedback, resolveExamMeta } from "@/lib/calibration";
import { useCourseOr404 } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";
import { readJson, withBodyLimit } from "@/lib/upload-limit";
import { fieldTooLong } from "@/lib/field-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET : récap « ce que j'ai appris de tes retours » (cours courant). */
export async function GET(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  return NextResponse.json(await calibrationSummary());
}

/** POST {examId?, topic?, archetype?, verdict, note?, score?} : enregistre un retour. */
/** Verdicts acceptés (source unique, alignée sur l'UI et sur lib/calibration). */
const VERDICTS = ["too_easy", "good", "not_prof_style", "wrong"];

export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const b = await readJson(req, ({}));
  // Ces lignes nourrissent le bloc de calibration des prompts d'examen : verdict
  // dans son énumération, textes bornés, identifiant entier — sinon un retour
  // libre devient une consigne injectée dans toutes les générations suivantes.
  if (!VERDICTS.includes(String(b?.verdict))) {
    return NextResponse.json({ error: `verdict requis (${VERDICTS.join("|")}).` }, { status: 400 });
  }
  const tooLong = fieldTooLong("note", String(b.note ?? ""))
    ?? fieldTooLong("topic", String(b.topic ?? ""))
    ?? fieldTooLong("topic", String(b.archetype ?? ""));
  if (tooLong) return tooLong;
  const examId = b.examId == null || b.examId === "" ? null : Number(b.examId);
  if (examId !== null && (!Number.isSafeInteger(examId) || examId <= 0)) {
    return NextResponse.json({ error: "examId doit être un identifiant entier." }, { status: 400 });
  }
  // archétype/topic non fournis → les résoudre depuis l'exo généré (tag architect:<id>).
  let archetype = b.archetype ?? null;
  let topic = b.topic ?? null;
  if (examId && (!archetype || !topic)) {
    const meta = await resolveExamMeta(examId);
    archetype = archetype ?? meta.archetype;
    topic = topic ?? meta.topic;
  }
  const id = await recordFeedback({
    examId,
    topic,
    archetype,
    verdict: String(b.verdict),
    note: b.note ?? null,
    score: typeof b.score === "number" ? b.score : null,
  });
  return NextResponse.json({ ok: true, id, archetype, topic });
}
)