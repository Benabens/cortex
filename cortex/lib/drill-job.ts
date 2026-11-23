import crypto from "node:crypto";
import { currentCourse } from "@/db/client";
import { currentUser } from "@/db/context";
import { generateDrill, type Drill } from "@/lib/drill";
import { q } from "@/db/q";
import { fmtCreditsBack } from "@/lib/billing/credits";
import { jobErrorOf, type JobError } from "@/lib/i18n/job-text";
import { activeJob, getJob, insertReservedJob, loadJobCheckpoint, logJob, ReservationRefused, saveJobCheckpoint, setJob, startWorker, type Job } from "@/lib/jobs";
import { userError } from "@/lib/i18n/user-error";

/**
 * DRILL EN JOB (connecteur MCP) : un drill prend une à trois minutes, et un client MCP coupe un
 * appel resté sans réponse (« MCP server connection lost », CS-250 du 21/11/2026, 187 s). Comme
 * generate_mock_exam, generate_drill rend donc un job_id ; get_job_status rend l'exercice prêt.
 *
 * La facturation reste celle d'une aide : le prix d'une aide réservé AVANT le job (rafale, quota du jour
 * des aides, solde : un refus revient tout de suite, sans job), sous une référence de job
 * (`job:<user>:<cours>:<uuid>`) que la réconciliation sait reprendre ; le worker appelle le modèle
 * sous cette preuve d'aide (modèle et taille bornés, lib/llm) et rend le crédit selon la règle de
 * assistCall. Le drill de l'app web reste synchrone (route /api/drill) : rien ne change pour lui.
 */

/** Ce que le job range dans son point de reprise : l'exercice prêt (une reprise le livre sans rappeler le modèle). */
type DrillCheckpoint = { drill?: Drill };

/** Lance (ou retrouve) le drill du cours. Lève AssistRefused / ReservationRefused sans rien débiter. */
export async function startDrillJob(concept: string): Promise<{ jobId: number; existing: boolean }> {
  const running = await activeJob("drill");
  if (running) return { jobId: running.id, existing: true };
  const user = currentUser();
  const course = currentCourse();
  const { isCourseDeleting } = await import("@/lib/course-deletion");
  if (await isCourseDeleting(user, course)) throw new ReservationRefused(409, userError("course_deleting_generation_refused"));
  const { AssistRefused, assistReserve, releaseQuotaEvent } = await import("@/lib/billing/reserve");
  const ref = `job:${user}:${course}:${crypto.randomUUID()}`;
  const r = await assistReserve("drill", ref);
  if ("issue" in r) throw new AssistRefused(r.issue);
  const res = await insertReservedJob("drill", JSON.stringify({ concept }), ref);
  if (res.existing) {
    // Un autre appel a créé le drill pendant la réservation : la nôtre n'a servi à rien.
    const { refundGeneration } = await import("@/lib/billing/credits");
    await refundGeneration("assist drill", ref, user).catch(() => 0);
    await releaseQuotaEvent(user, ref);
    return { jobId: res.id, existing: true };
  }
  await startWorker(res.id);
  return { jobId: res.id, existing: false };
}

type DrillRun = { ok: true; drill: Drill } | { ok: false; error: unknown; backCenti: number };

/** L'exercice du job, ou l'échec et ce qui a été rendu (règle des aides : lib/billing/reserve). */
async function runDrill(job: Pick<Job, "id" | "target">, creditRef: string | null): Promise<DrillRun> {
  const ready = await loadJobCheckpoint<DrillCheckpoint>(job.id);
  if (ready?.drill) return { ok: true, drill: ready.drill };
  let concept = "";
  try { concept = String((JSON.parse(job.target ?? "{}") as { concept?: unknown }).concept ?? "").trim(); } catch { /* cible illisible */ }
  if (!concept || !creditRef) return { ok: false, error: new Error("Drill sans notion ou sans réservation."), backCenti: 0 };
  const { runWithLlmAuthorization } = await import("@/lib/llm/authorization");
  try {
    const drill = await runWithLlmAuthorization({ kind: "assist", ref: creditRef }, () => generateDrill(concept));
    await saveJobCheckpoint(job.id, { drill } satisfies DrillCheckpoint);
    return { ok: true, drill };
  } catch (e) {
    const { refundAssistFailure } = await import("@/lib/billing/reserve");
    const backCenti = await refundAssistFailure("drill", creditRef, e).catch(() => 0);
    return { ok: false, error: e, backCenti };
  }
}

/**
 * Exécute le job drill (scripts/run-job.ts, dans le cours et le compte du job) : « running », puis
 * « done » avec l'exercice dans son point de reprise, ou « error » avec ce qui a été rendu. Le
 * worker ne rembourse rien de plus : la règle des aides est déjà appliquée.
 */
export async function executeDrillJob(jobId: number): Promise<{ ok: true } | { ok: false; message: string; info: JobError }> {
  const job = await getJob(jobId);
  if (!job || job.type !== "drill") return { ok: false, message: `Job ${jobId} : pas un drill.`, info: userError("job_failed") };
  const creditRef = (await q.get<{ credit_ref: string | null }>(`SELECT credit_ref FROM jobs WHERE id = ?`, jobId))?.credit_ref ?? null;
  await setJob(jobId, { status: "running", pid: process.pid, currentStep: "Écriture de l'exercice…", progress: 10 });
  const r = await runDrill(job, creditRef);
  if (!r.ok) {
    const raw = (r.error as Error)?.message || String(r.error);
    const message = r.backCenti > 0 ? `${raw} — ${fmtCreditsBack(r.backCenti)}.` : raw;
    const info: JobError = r.backCenti > 0 ? { ...jobErrorOf(r.error), creditsBackCenti: r.backCenti } : jobErrorOf(r.error);
    await setJob(jobId, { status: "error", error: message, errorInfo: info });
    await logJob(jobId, "ERREUR : " + message);
    return { ok: false, message, info };
  }
  await setJob(jobId, { status: "done", progress: 100, currentStep: "Exercice prêt ✓", stepInfo: { key: "done" } });
  await logJob(jobId, "Exercice prêt ✓");
  return { ok: true };
}

/** L'exercice d'un job drill terminé (get_job_status), ou null. */
export async function drillOfJob(job: Pick<Job, "id" | "type" | "status">): Promise<Drill | null> {
  if (job.type !== "drill" || job.status !== "done") return null;
  return (await loadJobCheckpoint<DrillCheckpoint>(job.id))?.drill ?? null;
}
