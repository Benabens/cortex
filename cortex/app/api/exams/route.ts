import { deleteExam, listExams } from "@/lib/exam";
import { scheduleStats } from "@/lib/schedule";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ exams: listExams(), schedule: scheduleStats() });
}

export function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "id manquant" }, { status: 400 });
  deleteExam(id);
  return NextResponse.json({ ok: true });
}
