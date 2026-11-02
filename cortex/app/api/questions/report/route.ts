import { NextRequest, NextResponse } from "next/server";
import { useCourseOr404 } from "@/lib/req";
import { readJson, withBodyLimit } from "@/lib/upload-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Une « réponse fausse » est re-vérifiée par le modèle avant de répondre.
export const maxDuration = 240;

/** Signale une question d'un examen du cours (lib/question-reports). Gratuit. */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const body = await readJson(req, { examId: 0, kind: "", itemId: 0, reason: "", comment: "" });
  const { reportQuestion, ReportError } = await import("@/lib/question-reports");
  try {
    const r = await reportQuestion({
      examId: Number(body.examId), kind: String(body.kind) as "qcm" | "open" | "part", itemId: Number(body.itemId),
      reason: String(body.reason) as "wrong_answer", comment: typeof body.comment === "string" ? body.comment : null,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof ReportError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Signalement impossible pour le moment. Réessaie dans un instant." }, { status: 500 });
  }
});
