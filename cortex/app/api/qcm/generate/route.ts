import { activeJob, createJobExclusive, startWorker } from "@/lib/jobs";
import { getFormatProfile } from "@/lib/format";
import { preflightGeneration } from "@/lib/preflight";
import { useCourse } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET : le profil de format détecté (pour l'UI). */
export async function GET(req: NextRequest) {
  useCourse(req);
  return NextResponse.json({ format: await getFormatProfile() });
}

/** POST {count?, openCount?, focus?} : compose+génère un examen QCM (job arrière-plan). */
export async function POST(req: NextRequest) {
  const course = useCourse(req);
  const fmt = await getFormatProfile();
  if (!fmt?.has_mcq) return NextResponse.json({ error: "Format non détecté ou sans QCM pour ce cours. Lance la détection de format d'abord." }, { status: 400 });
  const existing = await activeJob("qcm");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true });
  const issue = await preflightGeneration("qcm");
  if (issue) return NextResponse.json({ error: issue.error, command: issue.command }, { status: issue.status });
  // composeur : count = N QCM, openCount = M ouvertes, focus = thème ciblé (exercice ciblé).
  const body = await req.json().catch(() => ({} as any));
  const num = (v: any) => (v === 0 || v === "0" ? 0 : Number(v) > 0 ? Math.min(40, Math.floor(Number(v))) : undefined);
  const c = num(body.count);
  const oc = num(body.openCount);
  if (c === 0 && oc === 0) return NextResponse.json({ error: "Composition vide : choisis au moins 1 QCM ou 1 question ouverte." }, { status: 400 });
  const target = JSON.stringify({
    count: c,
    openCount: oc,
    focus: typeof body.focus === "string" && body.focus.trim() ? body.focus.trim().slice(0, 400) : undefined,
  });
  const { id: jobId } = await createJobExclusive("qcm", target);
  try { await startWorker(jobId, course); }
  catch (e: any) { return NextResponse.json({ error: `worker : ${e?.message ?? e}` }, { status: 500 }); }
  return NextResponse.json({ ok: true, jobId });
}
