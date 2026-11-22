import crypto from "node:crypto";
import { currentCourse } from "@/db/client";
import { currentUser } from "@/db/context";
import { q } from "@/db/q";
import { checkSolution, type CheckResult } from "@/lib/check-solution";
import { fmtCreditsBack } from "@/lib/billing/credits";
import { jobErrorOf, type JobError } from "@/lib/i18n/job-text";
import { getJob, insertReservedJob, loadJobCheckpoint, logJob, ReservationRefused, saveJobCheckpoint, setJob, startWorker, type Job } from "@/lib/jobs";
import { userError } from "@/lib/i18n/user-error";

/**
 * CORRECTION EN JOB (connecteur MCP) : check_answer appelait le modèle (opus, délai de 200 s)
 * DANS la requête MCP ; 56 s mesurées en prod le 22/11/2026, et un client coupe un appel resté
 * sans réponse (le drill coupait à 187 s, cf. lib/drill-job). Comme generate_drill, check_answer
 * rend donc un job_id ; get_job_status rend la correction.
 *
 * Facturation d'une aide, inchangée : 0,3 crédit réservé AVANT le job (rafale, quota du jour des
 * aides, solde : refus immédiat, sans job), sous une référence de job que la réconciliation sait
 * reprendre ; le worker appelle le modèle sous cette preuve d'aide et rend le crédit selon la règle
 * de assistCall. La correction de l'app web reste synchrone (route /api/check-solution).
 */

/** Libellé du compteur d'aide (le même que la correction synchrone d'avant). */
const KIND = "check-solution";

type CheckTarget = { statement: string; answer: string };
type CheckCheckpoint = { check?: CheckResult };

/** Une correction est déjà en cours dans ce cours (une à la fois) : l'appelant ne doit pas croire que c'est la sienne. */
export class CheckAlreadyRunning extends Error {
  constructor(readonly jobId: number) {
    super(`Correction déjà en cours (job ${jobId}).`);
    this.name = "CheckAlreadyRunning";
  }
}

/**
 * Lance la correction. Lève AssistRefused / ReservationRefused sans rien débiter, et
 * CheckAlreadyRunning si une autre correction s'écrit : contrairement au drill, la rendre
 * ferait passer la note d'une AUTRE réponse pour celle-ci.
 */
export async function startCheckJob(target: CheckTarget): Promise<{ jobId: number }> {
  const user = currentUser();
  const course = currentCourse();
  const { isCourseDeleting } = await import("@/lib/course-deletion");
  if (await isCourseDeleting(user, course)) throw new ReservationRefused(409, userError("course_deleting_generation_refused"));
  const { AssistRefused, assistReserve, releaseQuotaEvent } = await import("@/lib/billing/reserve");
  const ref = `job:${user}:${course}:${crypto.randomUUID()}`;
  const r = await assistReserve(KIND, ref);
  if ("issue" in r) throw new AssistRefused(r.issue);
  const res = await insertReservedJob("check", JSON.stringify(target), ref);
  if (res.existing) {
    const { refundGeneration } = await import("@/lib/billing/credits");
    await refundGeneration(`assist ${KIND}`, ref, user).catch(() => 0);
    await releaseQuotaEvent(user, ref);
    throw new CheckAlreadyRunning(res.id);
  }
  await startWorker(res.id);
  return { jobId: res.id };
}

type CheckRun = { ok: true; check: CheckResult } | { ok: false; error: unknown; backCenti: number };

async function runCheck(job: Pick<Job, "id" | "target">, creditRef: string | null): Promise<CheckRun> {
  const ready = await loadJobCheckpoint<CheckCheckpoint>(job.id);
  if (ready?.check) return { ok: true, check: ready.check };
  let target: Partial<CheckTarget> = {};
  try { target = JSON.parse(job.target ?? "{}") as Partial<CheckTarget>; } catch { /* cible illisible */ }
  const statement = String(target.statement ?? "").trim();
  const answer = String(target.answer ?? "").trim();
  if (!statement || !answer || !creditRef) return { ok: false, error: new Error("Correction sans énoncé, sans réponse ou sans réservation."), backCenti: 0 };
  const { runWithLlmAuthorization } = await import("@/lib/llm/authorization");
  try {
    const check = await runWithLlmAuthorization({ kind: "assist", ref: creditRef }, () => checkSolution({ statement, answer, imageRel: null }));
    await saveJobCheckpoint(job.id, { check } satisfies CheckCheckpoint);
    return { ok: true, check };
  } catch (e) {
    const { refundAssistFailure } = await import("@/lib/billing/reserve");
    const backCenti = await refundAssistFailure(KIND, creditRef, e).catch(() => 0);
    return { ok: false, error: e, backCenti };
  }
}

/** Exécute le job de correction (scripts/run-job.ts, dans le cours et le compte du job). */
export async function executeCheckJob(jobId: number): Promise<{ ok: true } | { ok: false; message: string; info: JobError }> {
  const job = await getJob(jobId);
  if (!job || job.type !== "check") return { ok: false, message: `Job ${jobId} : pas une correction.`, info: userError("job_failed") };
  const creditRef = (await q.get<{ credit_ref: string | null }>(`SELECT credit_ref FROM jobs WHERE id = ?`, jobId))?.credit_ref ?? null;
  await setJob(jobId, { status: "running", pid: process.pid, currentStep: "Correction de la réponse…", progress: 10 });
  const r = await runCheck(job, creditRef);
  if (!r.ok) {
    const raw = (r.error as Error)?.message || String(r.error);
    const message = r.backCenti > 0 ? `${raw} — ${fmtCreditsBack(r.backCenti)}.` : raw;
    const info: JobError = r.backCenti > 0 ? { ...jobErrorOf(r.error), creditsBackCenti: r.backCenti } : jobErrorOf(r.error);
    await setJob(jobId, { status: "error", error: message, errorInfo: info });
    await logJob(jobId, "ERREUR : " + message);
    return { ok: false, message, info };
  }
  await setJob(jobId, { status: "done", progress: 100, currentStep: "Correction prête ✓", stepInfo: { key: "done" } });
  await logJob(jobId, "Correction prête ✓");
  return { ok: true };
}

/** La correction d'un job terminé (get_job_status), ou null. */
export async function checkOfJob(job: Pick<Job, "id" | "type" | "status">): Promise<CheckResult | null> {
  if (job.type !== "check" || job.status !== "done") return null;
  return (await loadJobCheckpoint<CheckCheckpoint>(job.id))?.check ?? null;
}
