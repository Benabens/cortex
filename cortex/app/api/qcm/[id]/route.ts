import { getQcmExam } from "@/lib/qcm";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET : le mock QCM SANS les clés (l'étudiant répond, la correction se fait via /grade). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  useCourse(req);
  const { id } = await params;
  const exam = getQcmExam(Number(id), false);
  if (!exam) return NextResponse.json({ error: "Mock introuvable." }, { status: 404 });
  return NextResponse.json(exam);
}
