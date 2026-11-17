import { currentCourse, runWithCourse } from "@/db/client";
import { currentUser, runWithUser } from "@/db/context";
import { dbDriverName, q, nowStr } from "@/db/q";
import { inc, log, observe } from "@/lib/metrics";
import { examsDir } from "@/lib/paths";
import { spawn } from "node:child_process";
import { killProcessGroup } from "@/lib/process-group";
import { isDraining, trackWorker, type TrackedWorker } from "@/lib/drain";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { storage } from "@/lib/storage";
import type { IngestReport } from "@/lib/ingest-report";

/**
 * Jobs de génération en ARRIÈRE-PLAN, découplés de la requête HTTP.
 * La route crée un job + lance un worker détaché ; l'UI poll l'avancement.
 * Le worker (scripts/run-job.ts) écrit ici après chaque étape → survit au reload.
 */
export type JobStatus = "queued" | "running" | "verifying" | "compiling" | "done" | "error" | "canceled";
export type JobType = "exam" | "exercise" | "ingest" | "blueprint" | "lab-exercise" | "qcm" | "format" | "prepare";
export type Job = {
  id: number;
  type: JobType;
  target: string | null;
  status: JobStatus;
  currentStep: string | null;
  progress: number;
  resultPath: string | null;
  resultId: number | null;
  error: string | null;
  log: { t: string; msg: string }[];
  /** Ingestion (ingest, prepare) : le sort de chaque fichier ; null pour les autres jobs. */
  report: IngestReport | null;
  pid: number | null;
  createdAt: string;
  updatedAt: string;
};

export async function ensureJobsSchema(): Promise<void> {
  await q.ensureTable("jobs");
  // Colonnes de durabilité — rattrapage pour les DB existantes.
  try { await q.ensureColumns("jobs", ["attempts", "max_attempts", "heartbeat_at", "checkpoint_json", "worker_id", "credit_ref", "report_json", "ordered"]); } catch {}
}
// (pas d'appel top-level : la table jobs est créée à la demande dans la DB du cours courant)

export async function createJob(type: JobType, target?: string): Promise<number> {
  await ensureJobsSchema();
  return await q.insert(
    `INSERT INTO jobs (type, target, status, current_step, progress) VALUES (?,?,'queued','En file…',0)`,
    type, target ?? null,
  );
}

/**
 * Création EXCLUSIVE (anti double-exécution) : re-vérifie le job actif du même
 * type DANS une transaction (le check `activeJob` des routes est un TOCTOU —
 * deux POST concurrents pouvaient spawner 2 workers). Renvoie le job existant
 * si un run du même type est déjà actif. `costCenti` : ce que CETTE création a
 * débité (0 pour un job existant réutilisé, le propriétaire ou sans facturation).
 */
export async function createJobExclusive(type: JobType, target?: string): Promise<{ id: number; existing: boolean; costCenti: number }> {
  await ensureJobsSchema();
  const activeSql = `SELECT id FROM jobs WHERE status IN ${ACTIVE_STATES} AND type = ? ORDER BY id DESC LIMIT 1`;
  const already = await q.get<{ id: number }>(activeSql, type);
  if (already) return { id: already.id, existing: true, costCenti: 0 };

  // POINT UNIQUE de la comptabilité de génération : UNE réservation atomique —
  // rafale, quota du jour, places en cours, solde — AVANT que le job n'existe.
  // Un refus ne laisse aucune ligne : rien à démarrer, rien qu'un second POST
  // puisse prendre pour un job « existant » et lancer sans débit. La référence
  // du débit est générée ici et portée par le job (colonne credit_ref) pour le
  // remboursement. `ingest` ne coûte rien. No-op sans garde-fou actif (dev €0).
  const user = currentUser();
  const course = currentCourse();
  // Cours en cours de suppression : rien ne démarre (le worker recréerait un schéma vide).
  const { isCourseDeleting } = await import("@/lib/course-deletion");
  if (await isCourseDeleting(user, course)) throw new ReservationRefused(409, "Ce cours est en cours de suppression : aucune génération possible.");
  let ref: string | null = null;
  let costCenti = 0;
  if (type !== "ingest") {
    const { reserveGeneration } = await import("@/lib/billing/reserve");
    ref = `job:${user}:${course}:${crypto.randomUUID()}`;
    let r: Awaited<ReturnType<typeof reserveGeneration>>;
    try {
      r = await reserveGeneration({ bucket: "gen", kind: type, costCenti: costForJob(type, target), ref, jobSlot: true });
    } catch (e) {
      // Erreur technique du store (pas un refus) : pas de génération gratuite sur erreur DB.
      // Détail (requête, chemin du store) dans les logs seulement — jamais à l'étudiant.
      const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
      log("error", "jobs.reservation_failed", { message: msg });
      throw new ReservationRefused(503, "Facturation indisponible, réessaie dans un instant.");
    }
    if (!r.ok) throw new ReservationRefused(r.status, r.error);
    costCenti = r.costCenti;
  }

  // Insertion EXCLUSIVE : le job actif du même type est re-vérifié DANS la
  // transaction (deux POST concurrents pouvaient spawner 2 workers). Si un
  // autre job a été créé pendant la réservation, celle-ci est rendue.
  const res = await q.tx(async () => {
    const active = await q.get<{ id: number }>(activeSql, type);
    if (active) return { id: active.id, existing: true };
    const id = await q.insert(
      `INSERT INTO jobs (type, target, status, current_step, progress, credit_ref) VALUES (?,?,'queued','En file…',0,?)`,
      type, target ?? null, ref,
    );
    return { id, existing: false };
  });
  if (res.existing && ref) await releaseReservation(type, ref, user);
  return { ...res, costCenti: res.existing ? 0 : costCenti };
}

/** Rend une réservation qui n'a finalement servi à rien (course perdue à l'insertion) : crédit, place en cours et génération du jour. */
async function releaseReservation(type: JobType, ref: string, user: string): Promise<void> {
  try {
    const { refundGeneration } = await import("@/lib/billing/credits");
    const { releaseJobSlot, releaseQuotaEvent } = await import("@/lib/billing/reserve");
    await refundGeneration(type, ref, user);
    await releaseJobSlot(user, ref);
    await releaseQuotaEvent(user, ref);
  } catch { /* best-effort */ }
}

/**
 * REVENDIQUE le démarrage d'un job : un seul appelant obtient `true` (UPDATE
 * conditionnel). Sans cela, deux startWorker concurrents sur un même job en
 * file — deux POST qui reçoivent le même « existing », la pompe et une route —
 * lançaient deux workers : double coût pour un seul paiement. Le worker pose
 * ensuite son PID réel dans worker_id ; une remise en file le remet à NULL, ou à
 * DEFERRED quand elle attend le conteneur suivant (arrêt gracieux, lib/drain).
 */
export async function claimJobStart(jobId: number): Promise<boolean> {
  const r = await q.run(
    `UPDATE jobs SET worker_id = 'spawn', updated_at = ? WHERE id = ? AND status = 'queued' AND (worker_id IS NULL OR worker_id = '' OR worker_id IN ('${DEFERRED}', '${WAITING}'))`,
    nowStr(), jobId,
  );
  return r.changes === 1;
}

/**
 * DÉFENSE EN PROFONDEUR CÔTÉ WORKER : le cours reçu en argument doit encore
 * appartenir à l'utilisateur du job (cours supprimé ou transféré entre la
 * réservation et l'exécution). Sinon le job passe en erreur SANS remboursement
 * (la réservation était légitime au moment du paiement) et rien n'est généré.
 * Renvoie true si le worker peut continuer.
 */
export async function assertJobCourseOwned(jobId: number, course: string): Promise<boolean> {
  const { ensureCoursesLoaded, ownsCourse, courseExists } = await import("@/lib/courses");
  const { isCourseDeleting } = await import("@/lib/course-deletion");
  await ensureCoursesLoaded();
  const user = currentUser();
  if (ownsCourse(user, course) && !(await isCourseDeleting(user, course))) return true;
  const msg = `Cours « ${course} » inaccessible pour ce compte (supprimé ou transféré), génération annulée.`;
  // Cours SUPPRIMÉ (ou en suppression) : n'écrire nulle part — toute requête
  // sur le tenant recréerait un schéma vide. Transféré à un autre compte : on
  // marque le job en erreur dans le tenant qui existe encore.
  if (!courseExists(course) || (await isCourseDeleting(user, course))) {
    console.error(`[jobs] ${msg}`);
    return false;
  }
  try {
    await setJob(jobId, { status: "error", error: msg });
    await logJob(jobId, msg);
  } catch { /* la base du cours peut avoir disparu avec lui */ }
  return false;
}

/** Refus de réservation (solde, quota, places) — la route le rend tel quel (402/429). */
export class ReservationRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ReservationRefused";
    this.status = status;
  }
}

/**
 * Coût en centièmes d'un job, PROPORTIONNEL à sa taille quand la route en
 * expose une (composeur) : un prix fixe pour une taille libre permettait de
 * demander 40 QCM ou 12 exercices pour le prix d'un mock standard.
 *  - qcm : 1 unité = le mock standard (20 QCM + 3 ouvertes, une ouverte
 *    comptant double → 26 équivalents) ; au-delà, une unité par tranche ;
 *  - exam : 8 exercices inclus, puis 1 crédit par tranche de 4.
 * Sans target (défauts du moteur) = tarif de base ; CREDITS_COST_JSON reste la base.
 */
const QCM_UNIT_EQUIV = 20 + 2 * 3;
export function costForJob(type: JobType, target?: string | null): number {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { creditCost, CENTI } = require("@/lib/billing/credits") as typeof import("@/lib/billing/credits");
  const base = creditCost(type);
  let t: Record<string, unknown> = {};
  try { t = target ? JSON.parse(target) : {}; } catch { /* target texte simple */ }
  if (type === "qcm") {
    const count = typeof t.count === "number" ? t.count : 20;
    const open = typeof t.openCount === "number" ? t.openCount : 3;
    const units = Math.max(1, Math.ceil((count + 2 * open) / QCM_UNIT_EQUIV));
    return base * units;
  }
  if (type === "exam") {
    const count = typeof t.count === "number" ? t.count : 0;
    return count > 8 ? base + CENTI * Math.ceil((count - 8) / 4) : base;
  }
  return base;
}

// ─────────────── Checkpointing durable ───────────────
// Un job long persiste sa progression PAR UNITÉ (lot/thème/question) en DB :
// après un crash/redémarrage, la reprise repart du dernier point, sans doublon.

export async function saveJobCheckpoint(id: number, data: unknown): Promise<void> {
  await q.run(`UPDATE jobs SET checkpoint_json = ?, updated_at = ? WHERE id = ?`,
    data === null || data === undefined ? null : JSON.stringify(data), nowStr(), id);
}

export async function loadJobCheckpoint<T>(id: number): Promise<T | null> {
  const r = await q.get<{ checkpoint_json: string | null }>(`SELECT checkpoint_json FROM jobs WHERE id = ?`, id);
  if (!r?.checkpoint_json) return null;
  try { return JSON.parse(r.checkpoint_json) as T; } catch { return null; }
}

/** Le point de reprise d'un job, sous la forme que lisent les générateurs (lib/qcm-checkpoint). */
export function jobCheckpointStore(id: number): { load(): Promise<unknown>; save(data: unknown): Promise<void> } {
  return { load: () => loadJobCheckpoint<unknown>(id), save: (data) => saveJobCheckpoint(id, data) };
}

/** Battement de cœur du worker (posé toutes les ~30 s, cf. scripts/run-job.ts). */
export async function heartbeatJob(id: number): Promise<void> {
  await q.run(`UPDATE jobs SET heartbeat_at = ?, worker_id = ? WHERE id = ?`, nowStr(), `${process.pid}`, id);
  const { heartbeatQueuedJob } = await import("@/lib/job-queue");
  await heartbeatQueuedJob(currentUser(), currentCourse(), id);
}

const TERMINAL_STATES: readonly JobStatus[] = ["done", "error", "canceled"];

export async function setJob(id: number, fields: Partial<{ status: JobStatus; currentStep: string; progress: number; resultPath: string; resultId: number; ordered: number; error: string; pid: number }>): Promise<void> {
  const map: Record<string, string> = { status: "status", currentStep: "current_step", progress: "progress", resultPath: "result_path", resultId: "result_id", ordered: "ordered", error: "error", pid: "pid" };
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    sets.push(`${map[k]} = ?`);
    vals.push(v);
  }
  if (!sets.length) return;
  sets.push(`updated_at = ?`);
  vals.push(nowStr());
  // Un job TERMINÉ ne se rouvre pas : les étapes des générations ne sont pas toujours
  // attendues (onStep appelé sans await), et une progression arrivée en retard écrasait
  // « done, 100 % » (préparation affichée finie à 98 %, 27/10/2026). Seul un nouvel état
  // terminal peut s'écrire sur un job terminé.
  const finishing = !!fields.status && TERMINAL_STATES.includes(fields.status);
  const stillOpen = finishing ? "" : ` AND status NOT IN (${TERMINAL_STATES.map((st) => `'${st}'`).join(", ")})`;
  await q.run(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?${stillOpen}`, ...vals, id);
  // État terminal : la place « génération en cours » du compte est libérée, et celle de l'instance.
  if (finishing) {
    const { releaseJob } = await import("@/lib/job-queue");
    await releaseJob(currentUser(), currentCourse(), id);
    try {
      const row = await q.get<{ credit_ref: string | null }>(`SELECT credit_ref FROM jobs WHERE id = ?`, id);
      if (row?.credit_ref) {
        const { releaseJobSlot } = await import("@/lib/billing/reserve");
        await releaseJobSlot(currentUser(), row.credit_ref);
      }
    } catch { /* best-effort */ }
  }
  // Métriques : durée d'un job à son état terminal.
  if (fields.status && ["done", "error", "canceled"].includes(fields.status)) {
    try {
      const j = await q.get<{ type: string; created_at: string }>(`SELECT type, created_at FROM jobs WHERE id = ?`, id);
      if (j) {
        inc("cortex_jobs_total", { type: j.type, status: fields.status });
        const ms = Date.now() - new Date(j.created_at + "Z").getTime();
        if (Number.isFinite(ms) && ms >= 0) observe("cortex_job_duration_ms", ms, { type: j.type });
      }
    } catch { /* métrique best-effort */ }
  }
}

export async function logJob(id: number, msg: string): Promise<void> {
  // Transactionnel : les onStep sont émis sans await (fire-and-forget) —
  // sans tx, deux logJob concurrents relisaient le même tableau et s'écrasaient
  // mutuellement (entrées perdues, cf. race read-modify-write historique).
  // En Postgres (READ COMMITTED) la transaction ne suffit pas : sans verrou de
  // ligne, deux écritures relisent le même tableau et l'une efface l'autre
  // (job 8 de CS-290 : la moitié des étapes perdues, dont la cause d'un échec).
  const lock = dbDriverName() === "postgres" ? " FOR UPDATE" : "";
  await q.tx(async () => {
    const row = await q.get<{ log_json: string }>(`SELECT log_json FROM jobs WHERE id = ?${lock}`, id);
    let arr: { t: string; msg: string }[] = [];
    try { arr = JSON.parse(row?.log_json ?? "[]"); } catch {}
    arr.push({ t: new Date().toISOString(), msg });
    if (arr.length > 60) arr = arr.slice(-60);
    await q.run(`UPDATE jobs SET log_json = ?, updated_at = ? WHERE id = ?`, JSON.stringify(arr), nowStr(), id);
  });
}

/** Helper combiné : met à jour étape+progress et logue. */
export async function reportJob(id: number, step: string, progress: number, status?: JobStatus): Promise<void> {
  await setJob(id, { currentStep: step, progress, ...(status ? { status } : {}) });
  await logJob(id, step);
}

/** Le rapport par fichier de la dernière ingestion du cours courant (job d'ingestion ou de préparation), ou null. */
export async function lastIngestReport(): Promise<IngestReport | null> {
  await ensureJobsSchema();
  const row = await q.get<{ report_json: string }>(`SELECT report_json FROM jobs WHERE report_json IS NOT NULL ORDER BY id DESC LIMIT 1`);
  try { return row ? (JSON.parse(row.report_json) as IngestReport) : null; } catch { return null; }
}

/** Range le rapport par fichier d'une ingestion sur son job (lu par l'interface et par MCP). */
export async function setJobReport(id: number, report: IngestReport): Promise<void> {
  await ensureJobsSchema();
  await q.run(`UPDATE jobs SET report_json = ?, updated_at = ? WHERE id = ?`, JSON.stringify(report), nowStr(), id);
}

function rowToJob(r: any): Job {
  let log: { t: string; msg: string }[] = [];
  try { log = JSON.parse(r.log_json ?? "[]"); } catch {}
  let report: IngestReport | null = null;
  try { report = r.report_json ? JSON.parse(r.report_json) : null; } catch {}
  return {
    id: r.id, type: r.type, target: r.target, status: r.status, currentStep: r.current_step,
    progress: r.progress, resultPath: r.result_path, resultId: r.result_id, error: r.error,
    log, report, pid: r.pid, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Le process `pid` est-il encore vivant ? (signal 0 = test d'existence, ne tue rien). */
function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

/** La référence de débit a été émise pour ce compte et ce cours (createJobExclusive : job:<user>:<course>:<uuid>). */
function refIssuedTo(ref: string | null, user: string, course: string): boolean {
  const prefix = `job:${user}:${course}:`;
  return !!ref && ref.startsWith(prefix) && !ref.slice(prefix.length).includes(":");
}

const ACTIVE_STATES = "('queued','running','verifying','compiling')";
/**
 * worker_id d'un job en file qui attend le conteneur suivant : créé ou repris pendant un arrêt
 * gracieux, ou remis en file à son échéance. Sa réservation de crédits a déjà eu lieu ; la pompe le
 * démarre au prochain boot, et la réconciliation ne le prend pas pour un spawn raté.
 */
const DEFERRED = "deferred";
/**
 * worker_id d'un job en file qui attend une place de l'instance (lib/job-queue, MAX_GLOBAL_JOBS) :
 * sa réservation est faite, la distribution le démarre à son tour. Pas un spawn raté non plus.
 */
const WAITING = "waiting";
const DEFERRED_MSG = "Mise à jour du serveur : le job démarre dans quelques minutes.";
const HANDOFF_MSG = "Mise à jour du serveur : reprise automatique dans quelques minutes, progression conservée.";
const ZOMBIE_MSG = "Worker interrompu (process arrêté), la génération ne tournait plus. Relance.";
/** Un worker vivant qui n'a plus de heartbeat depuis ce délai est considéré bloqué. */
const STALL_MS = 15 * 60_000;
/**
 * Un battement plus récent que ce délai vaut preuve de vie, même si le PID est
 * absent d'ici (battement toutes les 30 s ; marge pour un appel synchrone,
 * pdftoppm jusqu'à 60 s, qui retient la boucle d'événements).
 */
const HEARTBEAT_FRESH_MS = 5 * 60_000;

/**
 * ZÉRO JOB ZOMBIE, ZÉRO RUN PERDU : réconcilie les jobs « actifs » dont le worker
 * n'est plus vivant. Un battement de cœur de moins de HEARTBEAT_FRESH_MS prime sur
 * tout le reste : le worker vit, peut-être sur un autre conteneur. Sinon, un job est
 * zombie si (a) son PID est enregistré mais le process est mort,
 * (b) il est resté sans PID au-delà d'un délai franc (le worker n'a jamais démarré), ou
 * (c) son PID est « vivant » mais son heartbeat (posé toutes les 30 s par le worker) date de
 * plus de STALL_MS — worker suspendu, ou PID recyclé par l'OS.
 *
 * Un zombie n'est plus condamné — tant que attempts < max_attempts il est RE-MIS EN
 * FILE (checkpoint conservé → la reprise repart du dernier lot, sans doublon) ; la pompe
 * (pumpQueuedJobs, appelée par instrumentation + polling) relance alors un worker. Au-delà
 * du budget de tentatives → 'error' (bouton réessayer).
 */
export async function reconcileStaleJobs(): Promise<number> {
  await ensureJobsSchema();
  const rows = await q.all<{ id: number; type: string; status: string; pid: number | null; created_at: string; updated_at: string; heartbeat_at: string | null; attempts: number; max_attempts: number; credit_ref: string | null; worker_id: string | null }>(
    `SELECT id, type, status, pid, created_at, updated_at, heartbeat_at, attempts, max_attempts, credit_ref, worker_id FROM jobs WHERE status IN ${ACTIVE_STATES}`,
  );
  let fixed = 0;
  for (const r of rows) {
    let zombie = false;
    const hbAge = r.heartbeat_at ? Date.now() - new Date(r.heartbeat_at + "Z").getTime() : NaN;
    // Battement récent : le worker vit, OÙ QU'IL TOURNE — son PID n'a de sens que
    // sur son propre conteneur (déploiement sans volume, second réplica).
    if (Number.isFinite(hbAge) && hbAge <= HEARTBEAT_FRESH_MS) continue;
    if (r.pid) {
      if (!isPidAlive(r.pid)) zombie = true; // worker mort (ou ailleurs, mais muet depuis HEARTBEAT_FRESH_MS)
      else if (r.heartbeat_at) {
        // PID « vivant » mais plus aucun battement : worker suspendu ou PID recyclé.
        if (Number.isFinite(hbAge) && hbAge > STALL_MS) zombie = true;
      }
    } else if (r.status === "queued" && (r.worker_id === DEFERRED || r.worker_id === WAITING)) {
      // Différé par un arrêt gracieux, ou en file d'attente de l'instance : ce n'est pas un spawn raté.
      continue;
    } else {
      // sans PID : le worker n'a jamais démarré → zombie si plus vieux que 120 s (startWorker persiste
      // le PID immédiatement après le spawn ; 2 min sans PID = spawn échoué).
      const ageMs = Date.now() - new Date((r.updated_at || r.created_at) + "Z").getTime();
      if (Number.isFinite(ageMs) && ageMs > 120_000) zombie = true;
    }
    if (!zombie) continue;
    fixed++;
    const attempts = r.attempts ?? 0;
    const maxAttempts = r.max_attempts ?? 2;
    // Jamais démarré (aucun PID, aucune tentative) : on ne le remet PAS en file —
    // la pompe lancerait un worker sans garantie que la réservation de crédits a
    // eu lieu (spawn échoué, ou réservation impossible dont la mise en erreur a
    // elle-même échoué). Erreur, remboursé si rien n'a coûté ; l'utilisateur relance.
    const neverStarted = !r.pid && attempts === 0;
    // Le propriétaire n'a aucune réservation débitée (reserveGeneration ne l'écrit
    // pas) : même exemption, même critère que la garde centrale du LLM — pour un
    // job dont la référence a été émise à SON nom (base partagée entre comptes).
    const reservationValid = r.type === "ingest"
      || (refIssuedTo(r.credit_ref, currentUser(), currentCourse()) && await (await import("@/lib/billing/owner")).isOwner())
      || await (await import("@/lib/llm/authorization")).reservationExists(r.credit_ref);
    if (attempts < maxAttempts && !neverStarted && reservationValid) {
      const msg = `Worker interrompu, reprise automatique (tentative ${attempts + 1}/${maxAttempts}), progression conservée.`;
      await q.run(
        `UPDATE jobs SET status = 'queued', pid = NULL, heartbeat_at = NULL, worker_id = NULL, attempts = ?, current_step = ?, updated_at = ? WHERE id = ?`,
        attempts + 1, msg, nowStr(), r.id,
      );
      await logJob(r.id, msg);
      const { requeueJob } = await import("@/lib/job-queue");
      await requeueJob(currentUser(), currentCourse(), r.id);
    } else {
      const error = reservationValid ? ZOMBIE_MSG : "Reprise annulée : la réservation de crédits est absente ou n’est plus valide.";
      await setJob(r.id, { status: "error", error });
      await logJob(r.id, error);
      // Le worker est mort sans passer par fail() : personne d'autre ne le signalera.
      const { captureError } = await import("@/lib/observability");
      captureError(new Error(`Job abandonné par la réconciliation : ${reservationValid ? "worker interrompu, tentatives épuisées" : "réservation absente"}`), {
        area: "jobs", step: "reconcile", job_type: r.type,
      });
      // Échec définitif hors du worker (celui-ci est mort sans passer par
      // fail()) → c'est ICI qu'il faut rendre les crédits : rien n'a été livré.
      await refundJobCredits({ id: r.id, type: r.type as JobType }, "failed");
    }
  }
  return fixed;
}

/**
 * POMPE DE REPRISE : relance un worker pour les jobs re-mis en file par la
 * réconciliation (queued, sans PID, pas tout frais). Appelée au boot + périodiquement
 * (instrumentation.ts) et par le polling des routes jobs — PAS par reconcileStaleJobs
 * (les tests de réconciliation ne doivent pas spawner de vrais workers).
 */
export async function pumpQueuedJobs(): Promise<number> {
  await ensureJobsSchema();
  if (isDraining()) return 0; // arrêt gracieux : c'est le conteneur suivant qui reprend
  const rows = await q.all<{ id: number; updated_at: string; created_at: string; worker_id: string | null }>(
    `SELECT id, updated_at, created_at, worker_id FROM jobs WHERE status = 'queued' AND pid IS NULL AND (attempts > 0 OR worker_id IN ('${DEFERRED}', '${WAITING}'))`,
  );
  let started = 0;
  for (const r of rows) {
    const ageMs = Date.now() - new Date((r.updated_at || r.created_at) + "Z").getTime();
    // Laisse le spawn initial se poser ; un job différé, lui, n'attend plus que nous.
    if (r.worker_id !== DEFERRED && r.worker_id !== WAITING && (!Number.isFinite(ageMs) || ageMs < 5_000)) continue;
    await startWorker(r.id);
    started++;
  }
  return started;
}

export async function getJob(id: number): Promise<Job | null> {
  await ensureJobsSchema();
  await reconcileStaleJobs();
  const r = await q.get(`SELECT * FROM jobs WHERE id = ?`, id);
  return r ? rowToJob(r) : null;
}

export async function listJobs(limit = 10): Promise<Job[]> {
  await ensureJobsSchema();
  await reconcileStaleJobs();
  return (await q.all<any>(`SELECT * FROM jobs ORDER BY id DESC LIMIT ?`, limit)).map(rowToJob);
}

/** Relance un job échoué/annulé : recrée un job de MÊME type+target et redémarre un worker.
 * Exclusif : si un job du même type est déjà actif, on le renvoie au lieu d'en empiler un 2ᵉ. */
export async function retryJob(id: number, course?: string): Promise<Job | null> {
  const old = await getJob(id);
  if (!old) return null;
  const { id: newId, existing } = await createJobExclusive(old.type, old.target ?? undefined);
  if (!existing) await startWorker(newId, course);
  return await getJob(newId);
}

/**
 * Lance le worker DÉTACHÉ : il survit à la requête HTTP et au rechargement de page.
 * Le `course` est passé en argv ET en env (CORTEX_COURSE) → le worker ouvre la BONNE DB.
 */
export async function startWorker(jobId: number, course?: string): Promise<void> {
  const cwd = process.cwd();
  const c = course ?? currentCourse();
  // Arrêt gracieux en cours (lib/drain) : ce conteneur ne prend plus de job. La réservation est
  // faite, le job reste en file, différé : le conteneur suivant le démarre à son boot.
  if (isDraining()) {
    await q.run(
      `UPDATE jobs SET worker_id = '${DEFERRED}', current_step = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND pid IS NULL AND (worker_id IS NULL OR worker_id = '' OR worker_id = '${WAITING}')`,
      DEFERRED_MSG, nowStr(), jobId,
    );
    return;
  }
  // PLAFOND DE L'INSTANCE (lib/job-queue) : sans place libre, ou s'il n'est pas en tête de file,
  // le job attend son tour, en file. Il est démarré par la distribution quand une place se libère.
  const { admitJob, dispatchQueue, releaseJob } = await import("@/lib/job-queue");
  const admission = await admitJob(currentUser(), c, jobId);
  if (!admission.admitted) {
    await q.run(
      `UPDATE jobs SET worker_id = '${WAITING}', current_step = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND pid IS NULL AND (worker_id IS NULL OR worker_id IN ('', '${DEFERRED}', '${WAITING}'))`,
      `En file d'attente (position ${admission.position}) : le serveur est à pleine charge, ta génération démarre dès qu'une place se libère.`,
      nowStr(), jobId,
    );
    return;
  }
  // Un seul démarrage par job en file (cf. claimJobStart) : ni un job terminé,
  // ni un job déjà pris par un autre appelant ne lance de worker.
  if (!(await claimJobStart(jobId))) {
    // Admis mais pas démarré : sans autre appelant qui le lance (job terminé ou disparu), la place
    // qu'il vient de prendre est rendue. Un job actif garde la sienne : c'est celle de son worker.
    const row = await q.get<{ status: string }>(`SELECT status FROM jobs WHERE id = ?`, jobId);
    if (!row || !ACTIVE_STATES.includes(`'${row.status}'`)) await releaseJob(currentUser(), c, jobId);
    return;
  }
  const tsxLocal = path.join(cwd, "node_modules", ".bin", "tsx");
  const useLocal = fs.existsSync(tsxLocal);
  const bin = useLocal ? tsxLocal : "npx";
  const tail = ["scripts/run-job.ts", String(jobId), c];
  const args = useLocal ? tail : ["tsx", ...tail];
  // CORTEX_USER : le worker détaché doit hériter du TENANT de l'appelant
  // (contexte requête = user connecté ; pompe/sweep = user du tenant balayé),
  // sinon en Postgres multi-user il écrirait dans le tenant « owner ».
  const env = { ...process.env, CORTEX_COURSE: c, CORTEX_USER: currentUser() };
  const child = spawn(bin, args, { cwd, detached: true, stdio: "ignore", env });
  // Suivi jusqu'à sa sortie : un arrêt gracieux attend ce worker (lib/drain).
  trackWorker(child, { jobId, user: env.CORTEX_USER, course: c });
  // Sa place se libère à sa sortie : le suivant de la file démarre sans attendre la pompe de 60 s.
  child.once("exit", () => { setTimeout(() => { void dispatchQueue().catch(() => {}); }, 1_000).unref(); });
  // PID persisté tout de suite (le worker le ré-écrit au démarrage) → annulable même pendant le démarrage
  if (child.pid) await setJob(jobId, { pid: child.pid });
  child.unref();
}

/**
 * ÉCHÉANCE D'UN ARRÊT GRACIEUX (lib/drain) : les workers de ce conteneur qui tournent encore sont
 * arrêtés, et leurs jobs remis en file, différés, avant le SIGKILL de la plateforme. Remis par
 * nous plutôt que découverts zombies par le conteneur suivant : sans ce passage, un battement de
 * moins de 5 min les faisait croire vivants (HEARTBEAT_FRESH_MS), et un PID réattribué dans le
 * nouveau conteneur pouvait les garder « running » à jamais. Aucune tentative consommée : un
 * déploiement n'est pas un échec du job. La reprise part de son point de reprise (checkpoint_json).
 */
export async function handOffJobs(workers: TrackedWorker[]): Promise<number> {
  let n = 0;
  for (const w of workers) {
    killProcessGroup(w.pid, { expectCommand: /run-job|tsx|node/, graceMs: 2_000 });
    // Mort constatée avant la remise en file : une écriture en vol du worker ne la recouvre pas.
    for (let t = 0; t < 30 && isPidAlive(w.pid); t++) await new Promise((r) => setTimeout(r, 100));
    await runWithUser(w.user, () => runWithCourse(w.course, async () => {
      const r = await q.run(
        `UPDATE jobs SET status = 'queued', pid = NULL, heartbeat_at = NULL, worker_id = '${DEFERRED}', current_step = ?, updated_at = ? WHERE id = ? AND status IN ${ACTIVE_STATES}`,
        HANDOFF_MSG, nowStr(), w.jobId,
      );
      if (r.changes === 1) {
        n++;
        await logJob(w.jobId, HANDOFF_MSG);
        const { requeueJob } = await import("@/lib/job-queue");
        await requeueJob(w.user, w.course, w.jobId);
      }
    })).catch(() => { /* tenant illisible : la réconciliation du conteneur suivant tranchera */ });
  }
  return n;
}

/**
 * Coût LLM réel d'un job (USD) : somme des lignes `llm_usage` rattachées au
 * même compte, même cours et même id — les ids de jobs sont séquentiels PAR
 * tenant, le triplet est indispensable.
 */
export async function jobLlmCostUsd(userId: string, course: string, jobId: number): Promise<number> {
  const { authGet } = await import("@/db/auth-store");
  const r = await authGet<{ total: number | string | null }>(
    `SELECT coalesce(sum(cost_usd), 0) total FROM llm_usage WHERE user_id = ? AND course = ? AND job_id = ?`,
    userId, course, String(jobId),
  );
  return Number(r?.total ?? 0);
}

/** Référence du débit d'un job : portée par le job (réservation avant insertion), sinon l'ancienne forme. */
async function jobCreditRef(jobId: number): Promise<string> {
  const { jobRef } = await import("@/lib/billing/credits");
  const row = await q.get<{ credit_ref: string | null }>(`SELECT credit_ref FROM jobs WHERE id = ?`, jobId);
  return row?.credit_ref ?? jobRef(currentUser(), currentCourse(), jobId);
}

/**
 * Ce qu'un examen QCM a déjà LIVRÉ : à la livraison progressive (onExamReady), le job reçoit
 * result_id (questions visibles sur /mock/<id>) et `ordered`, la taille commandée telle que le
 * générateur l'a résolue — format du cours compris, la cible n'en dit rien quand elle est vide.
 * Questions fermées et ouvertes comptées ensemble. null : rien de livré, ou pas un QCM.
 */
async function qcmDelivery(jobId: number): Promise<{ produced: number; requested: number } | null> {
  const row = await q.get<{ result_id: number | null; ordered: number | null }>(`SELECT result_id, ordered FROM jobs WHERE id = ?`, jobId);
  if (!row?.result_id || !row.ordered) return null;
  const requested = Number(row.ordered);
  const closed = (await q.get<{ n: number }>(`SELECT count(*) n FROM qcm_items WHERE exam_id = ?`, row.result_id))?.n ?? 0;
  const open = (await q.get<{ n: number }>(`SELECT count(*) n FROM exam_questions WHERE exam_id = ? AND source_inspiration = 'qcm-open'`, row.result_id))?.n ?? 0;
  return { produced: Number(closed) + Number(open), requested };
}

/**
 * Rend les crédits d'un job qui ne produira RIEN. Idempotent et seulement-si-
 * débité (cf. credits.ts). No-op sans facturation. Rend les centièmes rendus.
 *  - "failed" (échec définitif, zombie épuisé) : rendu EN ENTIER, même si des
 *    appels ont coûté — l'utilisateur n'a rien reçu, l'échec est le nôtre
 *    (réponse illisible, fournisseur en panne). L'abus reste borné : le quota
 *    quotidien de générations n'est pas rendu, et la dépense par compte et par
 *    jour est plafonnée en amont (lib/llm, assertSpendCap). Sauf un examen QCM
 *    déjà livré (worker mort ou exception après onExamReady) : seul le manque
 *    est rendu, au prorata des questions commandées, comme une livraison incomplète.
 *  - "canceled" (annulation par l'utilisateur) : rendu SEULEMENT si le job n'a
 *    rien coûté au fournisseur — sinon générer à 95 %, annuler et recommencer
 *    offrirait des générations illimitées.
 */
export async function refundJobCredits(job: Pick<Job, "id" | "type">, why: "failed" | "canceled" = "canceled"): Promise<number> {
  if (job.type === "ingest") return 0;
  try {
    const { billingEnabled, refundGeneration, fmtCreditsBack } = await import("@/lib/billing/credits");
    if (!billingEnabled()) return 0;
    if (why === "failed" && (job.type === "qcm" || job.type === "exam")) {
      const delivered = await qcmDelivery(job.id);
      if (delivered && delivered.requested > 0) {
        const missing = Math.max(0, delivered.requested - delivered.produced);
        if (!missing) {
          await logJob(job.id, `Crédits conservés : les ${delivered.produced} questions commandées étaient livrées avant l'échec.`).catch(() => {});
          return 0;
        }
        const back = await refundGeneration(job.type, await jobCreditRef(job.id), currentUser(), missing / delivered.requested);
        if (back > 0) {
          await logJob(job.id, `${fmtCreditsBack(back)} : ${delivered.produced} questions sur ${delivered.requested} livrées avant l'échec.`).catch(() => {});
        }
        return back;
      }
    }
    const spent = await jobLlmCostUsd(currentUser(), currentCourse(), job.id);
    if (why === "canceled" && spent > 0) {
      await logJob(job.id, `Crédits conservés : le job a déjà coûté ${spent.toFixed(3)} $ d'appels au modèle.`).catch(() => {});
      return 0;
    }
    const back = await refundGeneration(job.type, await jobCreditRef(job.id));
    if (back > 0) {
      await logJob(job.id, `${fmtCreditsBack(back)} : le job n'a rien produit${spent > 0 ? `, les ${spent.toFixed(3)} $ d'appels au modèle sont à notre charge` : ""}.`).catch(() => {});
    }
    return back;
  } catch { return 0; /* best-effort : jamais bloquant */ }
}

/**
 * Examen livré INCOMPLET : rembourse au prorata des questions manquantes
 * (idempotent : un seul remboursement par débit) et rend le message à montrer
 * à l'utilisateur — null si rien ne manque. Le prorata se compte en questions,
 * QCM et ouvertes confondues : c'est ce que l'utilisateur a commandé.
 */
export async function settleShortfall(job: Pick<Job, "id" | "type">, produced: number, requested: number): Promise<string | null> {
  const missing = Math.max(0, requested - produced);
  if (!missing || requested <= 0) return null;
  const what = missing === 1
    ? `1 question sur ${requested} n'a pas pu être générée`
    : `${missing} questions sur ${requested} n'ont pas pu être générées`;
  let notice = what;
  try {
    const { billingEnabled, refundGeneration, fmtCreditsBack } = await import("@/lib/billing/credits");
    const back = billingEnabled() ? await refundGeneration(job.type, await jobCreditRef(job.id), currentUser(), missing / requested) : 0;
    if (back > 0) notice = `${what} : ${fmtCreditsBack(back)}`;
  } catch { /* best-effort : le message reste dû */ }
  await logJob(job.id, `⚠ ${notice}.`).catch(() => {});
  return notice;
}

/**
 * Seuil d'avancement au-delà duquel une ANNULATION n'est plus remboursée : le
 * travail a réellement été facturé par le fournisseur (appels LLM déjà émis),
 * et un remboursement inconditionnel offrirait des générations illimitées
 * (générer à 95 %, annuler, recommencer). Filet supplémentaire : quel que soit
 * l'avancement, refundJobCredits ne rend rien d'une annulation si le job a déjà
 * coûté au fournisseur (un ÉCHEC, lui, est rendu : rien n'a été livré).
 */
const CANCEL_REFUND_MAX_PROGRESS = 10;

/**
 * Annule un job : statut `canceled`, puis TUE le worker pour de vrai.
 * On tue le GROUPE de processus du worker détaché → emporte aussi ses enfants
 * (`claude`, tectonic/pdflatex). Pas de génération zombie.
 */
export async function cancelJob(id: number): Promise<Job | null> {
  const job = await getJob(id);
  if (!job) return null;
  if (["done", "error", "canceled"].includes(job.status)) return job;
  // Examen QCM déjà visible (livraison progressive, onExamReady) : c'est une livraison, pas une
  // annulation. Banc HUM-285 du 16/11 : 20 QCM vérifiés et visibles, coupure à 90 min, examen
  // effacé par cleanupPartial et aucun crédit rendu. Le worker est arrêté d'abord (il n'écrit
  // plus), puis l'examen passe prêt avec ce qu'il contient et seul le manque est rendu.
  if (job.type === "qcm" && job.resultId) {
    if (job.pid) killProcessGroup(job.pid, { expectCommand: /run-job|tsx|node/ });
    const delivered = await qcmDelivery(id);
    if (delivered && delivered.produced > 0) {
      await closeQcmExam(job, delivered);
      const notice = await settleShortfall(job, delivered.produced, delivered.requested);
      await setJob(id, { status: "done", progress: 100, currentStep: notice ? `Terminé ⚠ ${notice}` : "Terminé ✓" });
      await logJob(id, `Annulé après livraison : ${delivered.produced}/${delivered.requested} questions déjà visibles conservées, worker tué.`);
      return await getJob(id);
    }
  }
  await setJob(id, { status: "canceled", currentStep: "Annulé" });
  // Annulation AVANT tout travail facturé → crédits rendus. Au-delà, le
  // fournisseur a déjà été payé : pas de remboursement (cf. constante).
  if (job.progress <= CANCEL_REFUND_MAX_PROGRESS) {
    await refundJobCredits(job, "canceled");
  } else {
    await logJob(id, `Annulé à ${job.progress}%, la génération était déjà lancée, les crédits ne sont pas rendus.`);
  }
  if (job.pid) {
    // Tout l'arbre (tsx re-spawne le script) : groupe via ps, sinon -pid (worker
    // détaché). Jamais un PID recyclé par un autre programme (commande vérifiée).
    killProcessGroup(job.pid, { expectCommand: /run-job|tsx|node/ });
  }
  await cleanupPartial(job);
  await logJob(id, "Annulé par l'utilisateur, worker tué, artefacts partiels nettoyés.");
  return await getJob(id);
}

/** Restes d'un job tué : checkpoint de génération + examen inséré mais jamais finalisé (compile interrompue). */
/** Examen QCM arrêté en cours de livraison : prêt tel qu'il est, résumé recompté sur la base. */
async function closeQcmExam(job: Job, delivered: { produced: number; requested: number }): Promise<void> {
  const target = (() => { try { return JSON.parse(job.target ?? "{}") as { openCount?: number }; } catch { return {}; } })();
  const openRequested = Math.max(0, Math.min(delivered.requested, Number(target.openCount ?? 0) || 0));
  const qcm = await q.get<{ n: number; v: number }>(`SELECT count(*) n, coalesce(sum(CASE WHEN verified = 1 THEN 1 ELSE 0 END), 0) v FROM qcm_items WHERE exam_id = ?`, job.resultId);
  const count = Number(qcm?.n ?? 0);
  const { qcmSummaryText } = await import("@/lib/exam-summary");
  const summary = qcmSummaryText({ count, requested: delivered.requested - openRequested, verified: Number(qcm?.v ?? 0), open: delivered.produced - count, openRequested });
  await q.run(`UPDATE exams SET status = 'ready', verify_summary = ? WHERE id = ?`, summary, job.resultId);
}

async function cleanupPartial(job: Job): Promise<void> {
  if (job.type === "exam") {
    try { await storage().remove(path.join(examsDir(), ".gen-checkpoint.json")); } catch {}
  }
  try { await saveJobCheckpoint(job.id, null); } catch {}
  try {
    // un examen fini a toujours html_path ; NULL + créé après le début du job = artefact partiel de CE job
    const orphans = await q.all<{ id: number }>(
      `SELECT id FROM exams WHERE html_path IS NULL AND created_at >= ?`,
      job.createdAt,
    );
    for (const { id: examId } of orphans) {
      await q.run(`DELETE FROM exam_questions WHERE exam_id = ?`, examId);
      await q.run(`DELETE FROM exams WHERE id = ?`, examId);
      for (const suffix of ["", "-corrige"])
        for (const ext of ["tex", "pdf", "html", "log", "aux"]) {
          try { await storage().remove(path.join(examsDir(), `exam-${examId}${suffix}.${ext}`)); } catch {}
        }
    }
  } catch {}
}

/**
 * Temps restant estimé d'un job actif (lib/eta), d'après la durée des derniers jobs
 * terminés du même type dans ce cours ; null pour un job terminé.
 */
/**
 * Ce qu'une étape d'un générateur écrit sur son job. Un avancement ≤ 0 est une simple ligne de
 * journal (« ⏱ QCM : … », « régénération ciblée ») : il ne touche ni l'avancement ni l'état — il
 * faisait retomber le job à 0 % en pleine génération, et son temps restant au total.
 */
export function stepFields(s: string, p: number, status: (p: number) => JobStatus): { currentStep: string; progress?: number; status?: JobStatus } {
  return p > 0 ? { currentStep: s, progress: p, status: status(p) } : { currentStep: s };
}

/**
 * Durée médiane de chaque phase (lignes « ⏱ » du journal) des derniers jobs TERMINÉS de ce type
 * dans ce cours : les poids de l'avancement par phase (lib/progress).
 */
export async function phaseHistory(type: string, limit = 5): Promise<Record<string, number>> {
  const { phaseDurationsFromLogs } = await import("@/lib/progress");
  const rows = await q.all<{ log_json: string | null }>(`SELECT log_json FROM jobs WHERE type = ? AND status = 'done' ORDER BY id DESC LIMIT ?`, type, limit).catch(() => []);
  return phaseDurationsFromLogs(rows.map((r) => {
    try { return JSON.parse(r.log_json ?? "[]") as { msg: string }[]; } catch { return []; }
  }));
}

export async function jobEta(job: Job): Promise<import("@/lib/eta").Eta | null> {
  if (!["queued", "running", "verifying", "compiling"].includes(job.status)) return null;
  const { estimateRemaining } = await import("@/lib/eta");
  const ms = (s: string) => new Date(`${s.replace(" ", "T")}Z`).getTime();
  const hist = await q.all<{ created_at: string; updated_at: string; target: string | null }>(
    `SELECT created_at, updated_at, target FROM jobs WHERE type = ? AND status = 'done' AND id <> ? ORDER BY id DESC LIMIT 5`, job.type, job.id,
  ).catch(() => []);
  const own = await q.get<{ target: string | null }>(`SELECT target FROM jobs WHERE id = ?`, job.id).catch(() => undefined);
  const row = await q.get<{ attempts: number | null }>(`SELECT attempts FROM jobs WHERE id = ?`, job.id).catch(() => undefined);
  return estimateRemaining({
    type: job.type, status: job.status, progress: job.progress, elapsedMs: Math.max(0, Date.now() - ms(job.createdAt)),
    attempts: Number(row?.attempts ?? 0), historyMs: hist.map((h) => ms(h.updated_at) - ms(h.created_at)),
    historyUnits: hist.map((h) => orderedUnits(h.target)), units: orderedUnits(own?.target ?? null),
  });
}

/** Questions commandées par un job d'examen, lues dans sa cible (count + openCount) ; null si inconnues. */
function orderedUnits(target: string | null): number | null {
  try {
    const t = target ? (JSON.parse(target) as { count?: unknown; openCount?: unknown }) : null;
    const n = (typeof t?.count === "number" ? t.count : 0) + (typeof t?.openCount === "number" ? t.openCount : 0);
    return n > 0 ? n : null;
  } catch { return null; }
}

/** Le job actif le plus récent (pour réafficher la progression au reload). */
export async function activeJob(type?: JobType): Promise<Job | null> {
  await ensureJobsSchema();
  await reconcileStaleJobs();
  const where = type ? `AND type = '${type}'` : "";
  const r = await q.get(`SELECT * FROM jobs WHERE status IN ('queued','running','verifying','compiling') ${where} ORDER BY id DESC LIMIT 1`);
  return r ? rowToJob(r) : null;
}
