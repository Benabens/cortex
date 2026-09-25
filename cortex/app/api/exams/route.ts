import { deleteExam, listExams } from "@/lib/exam";
import { useCourseOr404 } from "@/lib/req";
import { scheduleStats } from "@/lib/schedule";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  return NextResponse.json({ exams: await listExams(), schedule: await scheduleStats() });
}

export async function DELETE(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ error: "id manquant" }, { status: 400 });
  await deleteExam(id);
  return NextResponse.json({ ok: true });
}
