/**
 * generate_drill rend un job (lib/drill-job) : le worker détaché qu'il lance ne voit pas la base
 * en mémoire du test. Ce helper exécute le job DANS le test, comme le ferait le worker
 * (scripts/run-job.ts), puis rend ce que get_job_status lirait.
 */
type DrillStarted = { status: string; course: { id: string }; job: { job_id: number } | null };

export async function finishDrillJob(user: string, started: unknown): Promise<{ ok: boolean; jobId: number }> {
  const s = started as DrillStarted;
  if (!s?.job) throw new Error(`generate_drill n'a pas rendu de job : ${JSON.stringify(started)}`);
  const { runWithUser } = await import("../../db/context");
  const { runWithCourse } = await import("../../db/client");
  const { executeDrillJob } = await import("../../lib/drill-job");
  const r = await runWithUser(user, () => runWithCourse(s.course.id, () => executeDrillJob(s.job!.job_id)));
  return { ok: r.ok, jobId: s.job.job_id };
}
