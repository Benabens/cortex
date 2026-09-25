import { currentCourse } from "@/db/client";
import { q } from "@/db/q";
import { getCourse } from "@/lib/courses";
import { listExams } from "@/lib/exam";
import { activeJob } from "@/lib/jobs";
import { coverageNext, nextTopic, programOverview } from "@/lib/program";
import { useCourseOr404 } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dashboard d'accueil — agrégat course-aware : maîtrise/couverture, révisions dues,
 * compte à rebours d'examen, derniers examens, faiblesses, prochain type à travailler,
 * job en cours. 100 % lecture : ne touche à rien du moteur.
 */
export async function GET(req: NextRequest) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const id = currentCourse();
  const c = getCourse(id);

  // Programme (peut être vide si le cours n'a pas été analysé)
  let overview: Awaited<ReturnType<typeof programOverview>> | null = null;
  let next: Awaited<ReturnType<typeof nextTopic>> = null;
  let cover: Awaited<ReturnType<typeof coverageNext>> = null;
  try {
    overview = await programOverview();
    next = await nextTopic();
    cover = await coverageNext();
  } catch {
    /* pas de table topics → cours non analysé */
  }

  // Examens récents + planning (répétition espacée)
  let exams: Awaited<ReturnType<typeof listExams>> = [];
  let schedule = { total: 0, due: 0 };
  try {
    const r = (await listExams()) as any;
    exams = Array.isArray(r) ? r : r.exams ?? [];
  } catch {}
  try {
    const s = await require("@/lib/schedule").scheduleStats();
    schedule = { total: s.total, due: s.due };
  } catch {}

  // Faiblesses (compte + 3 dernières, par gravité)
  let weaknessCount = 0;
  let topWeaknesses: { id: number; topic: string; severity: number }[] = [];
  try {
    weaknessCount = ((await q.get<{ n: number }>(`SELECT count(*) n FROM weaknesses`)) as { n: number }).n;
    topWeaknesses = await q.all<any>(`SELECT id, topic, severity FROM weaknesses ORDER BY severity DESC, logged_at DESC LIMIT 3`);
  } catch {}

  // Compte à rebours d'examen
  let countdown: { date: string; days: number } | null = null;
  if (c.examDate) {
    const days = Math.ceil((new Date(c.examDate + "T00:00:00").getTime() - Date.now()) / 86400000);
    countdown = { date: c.examDate, days };
  }

  const job = (await activeJob()) ?? null;

  return NextResponse.json({
    course: { id, name: c.name, short: c.short, examCode: c.examCode, examKind: c.examKind },
    analyzed: !!(overview && overview.stats.total > 0),
    stats: overview?.stats ?? { total: 0, covered: 0, mastered: 0, due: 0, coveragePct: 0, masteryPct: 0 },
    next: next ? { id: next.id, label: next.label, category: next.category, examWeight: next.examWeight, status: next.status, mastery: next.mastery } : null,
    cover: cover ? { id: cover.id, label: cover.label, examWeight: cover.examWeight } : null,
    schedule,
    exams: exams.slice(0, 4),
    weaknesses: { count: weaknessCount, top: topWeaknesses },
    countdown,
    job: job ? { id: job.id, type: job.type, status: job.status, progress: job.progress, currentStep: job.currentStep, resultPath: job.resultPath } : null,
  });
}
