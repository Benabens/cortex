import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Signalements de tous les comptes : réservé au propriétaire de l'instance (404 sinon, rien à deviner). */
export async function GET() {
  const { isOwner } = await import("@/lib/billing/owner");
  if (!(await isOwner())) return NextResponse.json({ error: "Introuvable." }, { status: 404 });
  const { listReports, REASON_LABELS } = await import("@/lib/question-reports");
  const reports = await listReports(200);
  return NextResponse.json({ reports: reports.map((r) => ({ ...r, reasonLabel: REASON_LABELS[r.reason] ?? r.reason })) });
}
