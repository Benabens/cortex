import { currentCourse } from "@/db/client";
import { currentUser } from "@/db/context";
import { q, nowStr } from "@/db/q";
import { inc, observe } from "@/lib/metrics";
import { examsDir } from "@/lib/paths";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
  pid: number | null;
  createdAt: string;
  updatedAt: string;
};

export async function ensureJobsSchema(): Promise<void> {
  await q.ensureTable("jobs");
  // Colonnes de durabilité — rattrapage pour les DB existantes.
  try { await q.ensureColumns("jobs", ["attempts", "max_attempts", "heartbeat_at", "checkpoint_json", "worker_id"]); } catch {}
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
 * si un run du même type est déjà actif.
 */
export async function createJobExclusive(type: JobType, target?: string): Promise<{ id: number; existing: boolean }> {
  await ensureJobsSchema();
  const res = await q.tx(async () => {
    const active = await q.get<{ id: number }>(
      `SELECT id FROM jobs WHERE status IN ${ACTIVE_STATES} AND type = ? ORDER BY id DESC LIMIT 1`,
      type,
    );
    if (active) return { id: active.id, existing: true };
    const id = await q.insert(
      `INSERT INTO jobs (type, target, status, current_step, progress) VALUES (?,?,'queued','En file…',0)`,
      type, target ?? null,
    );
    return { id, existing: false };
  });
  // POINT UNIQUE de la comptabilité de génération (toutes les
  // routes de génération passent ici) : quota quotidien + débit de crédits,
  // idempotent par job (ref jobRef = user+cours+id). `ingest` ne coûte rien.
  // No-op sans DAILY_GEN_QUOTA/BILLING_ENABLED (dev €0 intact).
  if (!res.existing && type !== "ingest") {
    const { recordGeneration } = await import("@/lib/billing/guards");
    const { debitGeneration, jobRef } = await import("@/lib/billing/credits");
    await recordGeneration("gen", type);
    await debitGeneration(type, jobRef(currentUser(), currentCourse(), res.id));
  }
  return res;
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

/** Battement de cœur du worker (posé toutes les ~30 s, cf. scripts/run-job.ts). */
export async function heartbeatJob(id: number): Promise<void> {
  await q.run(`UPDATE jobs SET heartbeat_at = ?, worker_id = ? WHERE id = ?`, nowStr(), `${process.pid}`, id);
}

export async function setJob(id: number, fields: Partial<{ status: JobStatus; currentStep: string; progress: number; resultPath: string; resultId: number; error: string; pid: number }>): Promise<void> {
  const map: Record<string, string> = { status: "status", currentStep: "current_step", progress: "progress", resultPath: "result_path", resultId: "result_id", error: "error", pid: "pid" };
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
  await q.run(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
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
  await q.tx(async () => {
    const row = await q.get<{ log_json: string }>(`SELECT log_json FROM jobs WHERE id = ?`, id);
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

function rowToJob(r: any): Job {
  let log: { t: string; msg: string }[] = [];
  try { log = JSON.parse(r.log_json ?? "[]"); } catch {}
  return {
    id: r.id, type: r.type, target: r.target, status: r.status, currentStep: r.current_step,
    progress: r.progress, resultPath: r.result_path, resultId: r.result_id, error: r.error,
    log, pid: r.pid, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Le process `pid` est-il encore vivant ? (signal 0 = test d'existence, ne tue rien). */
function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

const ACTIVE_STATES = "('queued','running','verifying','compiling')";
const ZOMBIE_MSG = "Worker interrompu (process arrêté) — la génération ne tournait plus. Relance.";
/** Un worker vivant qui n'a plus de heartbeat depuis ce délai est considéré bloqué. */
const STALL_MS = 15 * 60_000;

/**
 * ZÉRO JOB ZOMBIE, ZÉRO RUN PERDU : réconcilie les jobs « actifs » dont le worker
 * n'est plus vivant. Un job est zombie si (a) son PID est enregistré mais le process est mort,
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
  const rows = await q.all<{ id: number; type: string; pid: number | null; created_at: string; updated_at: string; heartbeat_at: string | null; attempts: number; max_attempts: number }>(
    `SELECT id, type, pid, created_at, updated_at, heartbeat_at, attempts, max_attempts FROM jobs WHERE status IN ${ACTIVE_STATES}`,
  );
  let fixed = 0;
  for (const r of rows) {
    let zombie = false;
    if (r.pid) {
      if (!isPidAlive(r.pid)) zombie = true; // worker mort
      else if (r.heartbeat_at) {
        // PID « vivant » mais plus aucun battement : worker suspendu ou PID recyclé.
        const hbAge = Date.now() - new Date(r.heartbeat_at + "Z").getTime();
        if (Number.isFinite(hbAge) && hbAge > STALL_MS) zombie = true;
      }
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
    if (attempts < maxAttempts) {
      const msg = `Worker interrompu — reprise automatique (tentative ${attempts + 1}/${maxAttempts}), progression conservée.`;
      await q.run(
        `UPDATE jobs SET status = 'queued', pid = NULL, heartbeat_at = NULL, attempts = ?, current_step = ?, updated_at = ? WHERE id = ?`,
        attempts + 1, msg, nowStr(), r.id,
      );
      await logJob(r.id, msg);
    } else {
      await setJob(r.id, { status: "error", error: ZOMBIE_MSG });
      await logJob(r.id, ZOMBIE_MSG);
      // Échec définitif hors du worker (celui-ci est mort sans passer par
      // fail()) → c'est ICI qu'il faut rendre les crédits.
      await refundJobCredits({ id: r.id, type: r.type as JobType });
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
  const rows = await q.all<{ id: number; updated_at: string; created_at: string }>(
    `SELECT id, updated_at, created_at FROM jobs WHERE status = 'queued' AND pid IS NULL AND attempts > 0`,
  );
  let started = 0;
  for (const r of rows) {
    const ageMs = Date.now() - new Date((r.updated_at || r.created_at) + "Z").getTime();
    if (!Number.isFinite(ageMs) || ageMs < 5_000) continue; // laisse le spawn initial se poser
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
  // PID persisté tout de suite (le worker le ré-écrit au démarrage) → annulable même pendant le démarrage
  if (child.pid) await setJob(jobId, { pid: child.pid });
  child.unref();
}


/**
 * Groupe de processus réel d'un PID (via ps, portable macOS/Linux).
 * Indispensable : `tsx` est un wrapper qui re-spawne le script → le PID enregistré par le
 * worker (process.pid) n'est PAS le leader du groupe ; seul kill(-pgid) emporte tout le monde.
 */
function pgidOf(pid: number): number | null {
  try {
    const out = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)]).toString().trim();
    const n = Number(out);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Annule un job : statut `canceled`, puis TUE le worker pour de vrai.
 * On tue le GROUPE de processus du worker détaché → emporte aussi ses enfants
 * (`claude`, tectonic/pdflatex). Pas de génération zombie.
 */
/**
 * Rend les crédits d'un job qui ne produira RIEN (échec définitif, zombie
 * épuisé, annulation). Idempotent et seulement-si-débité (cf. credits.ts) :
 * l'appeler deux fois ne rend pas deux fois. No-op sans facturation.
 */
export async function refundJobCredits(job: Pick<Job, "id" | "type">): Promise<void> {
  if (job.type === "ingest") return;
  try {
    const { refundGeneration, jobRef } = await import("@/lib/billing/credits");
    await refundGeneration(job.type, jobRef(currentUser(), currentCourse(), job.id));
  } catch { /* best-effort : jamais bloquant */ }
}

/**
 * Seuil d'avancement au-delà duquel une ANNULATION n'est plus remboursée : le
 * travail a réellement été facturé par le fournisseur (appels LLM déjà émis),
 * et un remboursement inconditionnel offrirait des générations illimitées
 * (générer à 95 %, annuler, recommencer). Un ÉCHEC reste toujours remboursé —
 * l'utilisateur n'y peut rien et n'obtient aucun livrable.
 */
const CANCEL_REFUND_MAX_PROGRESS = 10;

export async function cancelJob(id: number): Promise<Job | null> {
  const job = await getJob(id);
  if (!job) return null;
  if (["done", "error", "canceled"].includes(job.status)) return job;
  await setJob(id, { status: "canceled", currentStep: "Annulé" });
  // Annulation AVANT tout travail facturé → crédits rendus. Au-delà, le
  // fournisseur a déjà été payé : pas de remboursement (cf. constante).
  if (job.progress <= CANCEL_REFUND_MAX_PROGRESS) {
    await refundJobCredits(job);
  } else {
    await logJob(id, `Annulé à ${job.progress}% — la génération était déjà lancée, les crédits ne sont pas rendus.`);
  }
  if (job.pid) {
    const pgid = pgidOf(job.pid);
    const target = pgid ? -pgid : job.pid; // repli : au moins le worker lui-même
    try { process.kill(target, "SIGTERM"); } catch {}
    const t = setTimeout(() => { try { process.kill(target, "SIGKILL"); } catch {} }, 3_000);
    (t as any).unref?.();
  }
  await cleanupPartial(job);
  await logJob(id, "Annulé par l'utilisateur — worker tué, artefacts partiels nettoyés.");
  return await getJob(id);
}

/** Restes d'un job tué : checkpoint de génération + examen inséré mais jamais finalisé (compile interrompue). */
async function cleanupPartial(job: Job): Promise<void> {
  if (job.type === "exam") {
    try { fs.unlinkSync(path.join(examsDir(), ".gen-checkpoint.json")); } catch {}
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
          try { fs.unlinkSync(path.join(examsDir(), `exam-${examId}${suffix}.${ext}`)); } catch {}
        }
    }
  } catch {}
}

/** Le job actif le plus récent (pour réafficher la progression au reload). */
export async function activeJob(type?: JobType): Promise<Job | null> {
  await ensureJobsSchema();
  await reconcileStaleJobs();
  const where = type ? `AND type = '${type}'` : "";
  const r = await q.get(`SELECT * FROM jobs WHERE status IN ('queued','running','verifying','compiling') ${where} ORDER BY id DESC LIMIT 1`);
  return r ? rowToJob(r) : null;
}
