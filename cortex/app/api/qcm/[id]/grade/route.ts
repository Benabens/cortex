import { getQcmExam, gradeQcm } from "@/lib/qcm";
import { recordFeedback } from "@/lib/calibration";
import { useCourseOr404 } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST {answers: {idx: number[]}} → corrige (clé connue), renvoie score + détail (idée fausse par
 * distracteur choisi). Le résultat nourrit la boucle de feedback de calibration.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const answers: Record<number, number[]> = body?.answers ?? {};
  const res = await gradeQcm(Number(id), answers);
  if (!res.total) return NextResponse.json({ error: "Mock introuvable ou vide." }, { status: 404 });
  // boucle d'apprentissage : un score global bas/haut sur ce mock = signal de calibration léger.
  try {
    const verdict = res.score / res.total >= 0.85 ? "too_easy" : res.score / res.total <= 0.4 ? "wrong" : "good";
    await recordFeedback({ examId: Number(id), archetype: "qcm", verdict, score: Math.round((res.score / res.total) * 10) });
  } catch {}
  // révèle les corrigés des questions ouvertes (auto-évaluation après soumission)
  const openSolutions = (await getQcmExam(Number(id), true))?.open ?? [];
  return NextResponse.json({ ...res, openSolutions });
}
