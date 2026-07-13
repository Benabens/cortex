import { currentCourse } from "@/db/client";
import { q, nowStr } from "@/db/q";
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
}
// (pas d'appel top-level : la table jobs est créée à la demande dans la DB du cours courant)

export async function createJob(type: JobType, target?: string): Promise<number> {
  await ensureJobsSchema();
  return await q.insert(
    `INSERT INTO jobs (type, target, status, current_step, progress) VALUES (?,?,'queued','En file…',0)`,
    type, target ?? null,
  );
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
}

export async function logJob(id: number, msg: string): Promise<void> {
  const row = await q.get<{ log_json: string }>(`SELECT log_json FROM jobs WHERE id = ?`, id);
  let arr: { t: string; msg: string }[] = [];
  try { arr = JSON.parse(row?.log_json ?? "[]"); } catch {}
  arr.push({ t: new Date().toISOString(), msg });
  if (arr.length > 60) arr = arr.slice(-60);
  await q.run(`UPDATE jobs SET log_json = ?, updated_at = ? WHERE id = ?`, JSON.stringify(arr), nowStr(), id);
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

/**
 * V8 — ZÉRO JOB ZOMBIE : réconcilie les jobs « actifs » dont le worker n'est plus vivant.
 * Un job est zombie si (a) son PID est enregistré mais le process est mort, ou (b) il est resté
 * sans PID au-delà d'un délai franc (le worker n'a jamais démarré). On NE touche PAS aux jobs dont
 * le PID est vivant, même s'ils n'ont pas loggé depuis un moment (un appel Claude de 10 min ne
 * rapporte rien entre-temps → le PID vivant est le seul signal fiable). Appelé sur chaque lecture
 * (heartbeat via le polling de l'UI) et au démarrage du serveur (instrumentation).
 */
export async function reconcileStaleJobs(): Promise<number> {
  await ensureJobsSchema();
  const rows = await q.all<{ id: number; pid: number | null; created_at: string; updated_at: string }>(
    `SELECT id, pid, created_at, updated_at FROM jobs WHERE status IN ${ACTIVE_STATES}`,
  );
  let fixed = 0;
  for (const r of rows) {
    let zombie = false;
    if (r.pid) {
      if (!isPidAlive(r.pid)) zombie = true; // worker mort
    } else {
      // sans PID : le worker n'a jamais démarré → zombie si plus vieux que 120 s (startWorker persiste
      // le PID immédiatement après le spawn ; 2 min sans PID = spawn échoué).
      const ageMs = Date.now() - new Date((r.updated_at || r.created_at) + "Z").getTime();
      if (Number.isFinite(ageMs) && ageMs > 120_000) zombie = true;
    }
    if (zombie) { await setJob(r.id, { status: "error", error: ZOMBIE_MSG }); await logJob(r.id, ZOMBIE_MSG); fixed++; }
  }
  return fixed;
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

/** Relance un job échoué/annulé : recrée un job de MÊME type+target et redémarre un worker. */
export async function retryJob(id: number, course?: string): Promise<Job | null> {
  const old = await getJob(id);
  if (!old) return null;
  const newId = await createJob(old.type, old.target ?? undefined);
  await startWorker(newId, course);
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
  const env = { ...process.env, CORTEX_COURSE: c };
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
export async function cancelJob(id: number): Promise<Job | null> {
  const job = await getJob(id);
  if (!job) return null;
  if (["done", "error", "canceled"].includes(job.status)) return job;
  await setJob(id, { status: "canceled", currentStep: "Annulé" });
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
