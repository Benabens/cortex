/**
 * check_answer rend un job (lib/check-job) : le worker détaché ne voit pas la base en mémoire du
 * test. Ce helper exécute le job DANS le test, comme le ferait le worker (scripts/run-job.ts).
 */
type CheckStarted = { status: string; course: { id: string }; job: { job_id: number } | null };

export async function finishCheckJob(user: string, started: unknown): Promise<{ ok: boolean; jobId: number }> {
  const s = started as CheckStarted;
  if (!s?.job) throw new Error(`check_answer n'a pas rendu de job : ${JSON.stringify(started)}`);
  const { runWithUser } = await import("../../db/context");
  const { runWithCourse } = await import("../../db/client");
  const { executeCheckJob } = await import("../../lib/check-job");
  const r = await runWithUser(user, () => runWithCourse(s.course.id, () => executeCheckJob(s.job!.job_id)));
  return { ok: r.ok, jobId: s.job.job_id };
}
