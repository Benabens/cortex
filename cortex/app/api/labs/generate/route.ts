import { activeJob, createJobExclusive, startWorker } from "@/lib/jobs";
import { labSeries, resolveLab } from "@/lib/labs";
import { preflightGeneration } from "@/lib/preflight";
import { requireCourse, useCourseOr404 } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET : la série Labs (un exo par lab, liens PDF énoncé+corrigé). */
export async function GET(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  return NextResponse.json({ series: await labSeries() });
}

/**
 * Exo « Labs » à la demande (moule Q6 2025, contenu = le vrai code du lab).
 * POST {lab?: "lab1"|"lab2"|"lab4"|"lab5", topic?: string} → job 'lab-exercise' en arrière-plan.
 */
export async function POST(req: NextRequest) {
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  const { lab, topic } = await req.json().catch(() => ({ lab: "", topic: "" }));
  const labStr = String(lab ?? "").trim();
  const topicStr = String(topic ?? "").trim();
  if (!labStr && !topicStr) {
    return NextResponse.json({ error: "Choisis un lab OU donne un sujet (ex. « direntv6 », « multi-threading »)." }, { status: 400 });
  }

  const existing = await activeJob("lab-exercise");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true });

  // pré-checks AVANT de lancer le worker : fournisseur LLM + corpus + moteur LaTeX
  const issue = await preflightGeneration("lab-exercise");
  if (issue) return NextResponse.json({ error: issue.error, command: issue.command }, { status: issue.status });

  const resolved = resolveLab(labStr || topicStr);
  const { id: jobId } = await createJobExclusive("lab-exercise", JSON.stringify({ lab: resolved.id, topic: topicStr || undefined }));
  try {
    await startWorker(jobId, course);
  } catch (e: any) {
    return NextResponse.json({ error: `Impossible de lancer le worker : ${e?.message ?? e}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, jobId, lab: resolved.id, labLabel: resolved.label });
}
