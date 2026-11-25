import crypto from "node:crypto";
import { currentCourse } from "@/db/client";
import { currentUser } from "@/db/context";
import { q } from "@/db/q";
import { checkSolution, type CheckResult } from "@/lib/check-solution";
import type { JobError } from "@/lib/i18n/job-text";
import { UserFacingError, userError } from "@/lib/i18n/user-error";
import { uploadsDir } from "@/lib/paths";
import path from "node:path";
import { ASSIST_FROM_WEB, assistJobFailed, getJob, insertReservedJob, loadJobCheckpoint, logJob, ReservationRefused, saveJobCheckpoint, setJob, startWorker, type Job } from "@/lib/jobs";

/**
 * CORRECTION EN JOB (connecteur MCP) : check_answer appelait le modèle (opus, délai de 200 s)
 * DANS la requête MCP ; 56 s mesurées en prod le 22/11/2026, et un client coupe un appel resté
 * sans réponse (le drill coupait à 187 s, cf. lib/drill-job). Comme generate_drill, check_answer
 * rend donc un job_id ; get_job_status rend la correction.
 *
 * Facturation d'une aide, inchangée : son prix réservé AVANT le job (rafale, quota du jour des
 * aides, solde : refus immédiat, sans job), sous une référence de job que la réconciliation sait
 * reprendre ; le worker appelle le modèle sous cette preuve d'aide et rend le crédit selon la règle
 * de assistCall. La correction de l'app web passe par le même job depuis le 24/11/2026 (route
 * /api/check-solution) : photo de la réponse et barème d'une question composée compris.
 */

/** Libellé du compteur d'aide (le même que la correction synchrone d'avant). */
const KIND = "check-solution";

export type CheckTarget = {
  statement: string;
  answer: string;
  /** Photo de la réponse : son NOM dans les envois du cours, jamais un chemin du serveur (la cible se lit sur /api/jobs). */
  image?: string;
  /** Réponse courte d'une question composée : barème et réponse modèle relus dans la base par le worker. */
  part?: { examId: number; partId: number };
  /** La question corrigée dans l'app : la page la retrouve au retour (lib/ux/generation questionOfTarget). */
  question?: { examId: number; questionId: number };
  /** Lancée par l'app : suivie par la pastille (lib/jobs ASSIST_FROM_WEB). */
  from?: "web";
};
type CheckCheckpoint = { check?: CheckResult };

/** Une correction est déjà en cours dans ce cours (une à la fois) : l'appelant ne doit pas croire que c'est la sienne. */
export class CheckAlreadyRunning extends Error {
  constructor(readonly jobId: number) {
    super(`Correction déjà en cours (job ${jobId}).`);
    this.name = "CheckAlreadyRunning";
  }
}

/**
 * Lance la correction. Lève AssistRefused / ReservationRefused sans rien débiter, et, pour un
 * assistant (MCP, une correction à la fois), CheckAlreadyRunning si la sienne s'écrit : contrairement
 * au drill, la rendre ferait passer la note d'une AUTRE réponse pour celle-ci. Dans l'app, chaque
 * réponse a sa correction, comme la route synchrone d'avant.
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
  const res = await insertReservedJob("check", JSON.stringify(target), ref, target.from === ASSIST_FROM_WEB.from ? "none" : "assistant");
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

const IMAGE_NAME = /^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/;

async function runCheck(job: Pick<Job, "id" | "target">, creditRef: string | null): Promise<CheckRun> {
  const ready = await loadJobCheckpoint<CheckCheckpoint>(job.id);
  if (ready?.check) return { ok: true, check: ready.check };
  let target: Partial<CheckTarget> = {};
  try { target = JSON.parse(job.target ?? "{}") as Partial<CheckTarget>; } catch { /* cible illisible */ }
  let statement = String(target.statement ?? "").trim();
  const answer = String(target.answer ?? "").trim();
  const imageRel = typeof target.image === "string" && IMAGE_NAME.test(target.image)
    ? path.relative(process.cwd(), path.join(uploadsDir(), target.image)) : null;
  if (!statement || (!answer && !imageRel) || !creditRef) return { ok: false, error: new Error("Correction sans énoncé, sans réponse ou sans réservation."), backCenti: 0 };
  let rubric: { rubric: { label: string; points: number }[]; reference: string } | null = null;
  if (target.part) {
    const { shortPartForCheck } = await import("@/lib/blocks");
    const part = await shortPartForCheck(Number(target.part.examId), Number(target.part.partId));
    if (!part) {
      // Examen supprimé entre le lancement et le worker : rien à corriger, l'aide est rendue.
      const { refundGeneration } = await import("@/lib/billing/credits");
      const backCenti = await refundGeneration(`assist ${KIND}`, creditRef).catch(() => 0);
      return { ok: false, error: new UserFacingError(userError("exam_part_not_found"), 404), backCenti };
    }
    ({ statement } = part);
    rubric = part;
  }
  const { runWithLlmAuthorization } = await import("@/lib/llm/authorization");
  try {
    const check = await runWithLlmAuthorization({ kind: "assist", ref: creditRef }, () =>
      checkSolution({ statement, answer, imageRel, ...(rubric ? { rubric: rubric.rubric, reference: rubric.reference } : {}) }));
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
    const { message, info } = await assistJobFailed(jobId, r.error, r.backCenti);
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
