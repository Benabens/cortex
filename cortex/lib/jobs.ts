import { currentCourse, sqlite } from "@/db/client";
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

export function ensureJobsSchema() {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    target TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    current_step TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    result_path TEXT,
    result_id INTEGER,
    error TEXT,
    log_json TEXT NOT NULL DEFAULT '[]',
    pid INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );`);
}
// (pas d'appel top-level : la table jobs est créée à la demande dans la DB du cours courant)

export function createJob(type: JobType, target?: string): number {
  ensureJobsSchema();
  return sqlite
    .prepare(`INSERT INTO jobs (type, target, status, current_step, progress) VALUES (?,?,'queued','En file…',0)`)
    .run(type, target ?? null).lastInsertRowid as number;
}

export function setJob(id: number, fields: Partial<{ status: JobStatus; currentStep: string; progress: number; resultPath: string; resultId: number; error: string; pid: number }>) {
  const map: Record<string, string> = { status: "status", currentStep: "current_step", progress: "progress", resultPath: "result_path", resultId: "result_id", error: "error", pid: "pid" };
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    sets.push(`${map[k]} = ?`);
    vals.push(v);
  }
  if (!sets.length) return;
  sets.push(`updated_at = datetime('now')`);
  sqlite.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}

export function logJob(id: number, msg: string) {
  const row = sqlite.prepare(`SELECT log_json FROM jobs WHERE id = ?`).get(id) as { log_json: string } | undefined;
  let arr: { t: string; msg: string }[] = [];
  try { arr = JSON.parse(row?.log_json ?? "[]"); } catch {}
  arr.push({ t: new Date().toISOString(), msg });
  if (arr.length > 60) arr = arr.slice(-60);
  sqlite.prepare(`UPDATE jobs SET log_json = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(arr), id);
}

/** Helper combiné : met à jour étape+progress et logue. */
export function reportJob(id: number, step: string, progress: number, status?: JobStatus) {
  setJob(id, { currentStep: step, progress, ...(status ? { status } : {}) });
  logJob(id, step);
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
export function reconcileStaleJobs(): number {
  ensureJobsSchema();
  const rows = sqlite
    .prepare(`SELECT id, pid, created_at, updated_at FROM jobs WHERE status IN ${ACTIVE_STATES}`)
    .all() as { id: number; pid: number | null; created_at: string; updated_at: string }[];
  let fixed = 0;
  for (const r of rows) {
    let zombie = false;
    if (r.pid) {
      if (!isPidAlive(r.pid)) zombie = true; // worker mort
    } else {
      // sans PID : le worker n'a jamais démarré → zombie si plus vieux que 120 s (startWorker pose
      // le PID synchronement ; 2 min sans PID = spawn échoué).
      const ageMs = Date.now() - new Date((r.updated_at || r.created_at) + "Z").getTime();
      if (Number.isFinite(ageMs) && ageMs > 120_000) zombie = true;
    }
    if (zombie) { setJob(r.id, { status: "error", error: ZOMBIE_MSG }); logJob(r.id, ZOMBIE_MSG); fixed++; }
  }
  return fixed;
}

export function getJob(id: number): Job | null {
  ensureJobsSchema();
  reconcileStaleJobs();
  const r = sqlite.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
  return r ? rowToJob(r) : null;
}

export function listJobs(limit = 10): Job[] {
  ensureJobsSchema();
  reconcileStaleJobs();
  return (sqlite.prepare(`SELECT * FROM jobs ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map(rowToJob);
}

/** Relance un job échoué/annulé : recrée un job de MÊME type+target et redémarre un worker. */
export function retryJob(id: number, course?: string): Job | null {
  const old = getJob(id);
  if (!old) return null;
  const newId = createJob(old.type, old.target ?? undefined);
  startWorker(newId, course);
  return getJob(newId);
}

/**
 * Lance le worker DÉTACHÉ : il survit à la requête HTTP et au rechargement de page.
 * Le `course` est passé en argv ET en env (CORTEX_COURSE) → le worker ouvre la BONNE DB.
 */
export function startWorker(jobId: number, course?: string) {
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
  if (child.pid) setJob(jobId, { pid: child.pid });
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
export function cancelJob(id: number): Job | null {
  const job = getJob(id);
  if (!job) return null;
  if (["done", "error", "canceled"].includes(job.status)) return job;
  setJob(id, { status: "canceled", currentStep: "Annulé" });
  if (job.pid) {
    const pgid = pgidOf(job.pid);
    const target = pgid ? -pgid : job.pid; // repli : au moins le worker lui-même
    try { process.kill(target, "SIGTERM"); } catch {}
    const t = setTimeout(() => { try { process.kill(target, "SIGKILL"); } catch {} }, 3_000);
    (t as any).unref?.();
  }
  cleanupPartial(job);
  logJob(id, "Annulé par l'utilisateur — worker tué, artefacts partiels nettoyés.");
  return getJob(id);
}

/** Restes d'un job tué : checkpoint de génération + examen inséré mais jamais finalisé (compile interrompue). */
function cleanupPartial(job: Job) {
  if (job.type === "exam") {
    try { fs.unlinkSync(path.join(examsDir(), ".gen-checkpoint.json")); } catch {}
  }
  try {
    // un examen fini a toujours html_path ; NULL + créé après le début du job = artefact partiel de CE job
    const orphans = sqlite
      .prepare(`SELECT id FROM exams WHERE html_path IS NULL AND datetime(created_at) >= datetime(?)`)
      .all(job.createdAt) as { id: number }[];
    for (const { id: examId } of orphans) {
      sqlite.prepare(`DELETE FROM exam_questions WHERE exam_id = ?`).run(examId);
      sqlite.prepare(`DELETE FROM exams WHERE id = ?`).run(examId);
      for (const suffix of ["", "-corrige"])
        for (const ext of ["tex", "pdf", "html", "log", "aux"]) {
          try { fs.unlinkSync(path.join(examsDir(), `exam-${examId}${suffix}.${ext}`)); } catch {}
        }
    }
  } catch {}
}

/** Le job actif le plus récent (pour réafficher la progression au reload). */
export function activeJob(type?: JobType): Job | null {
  ensureJobsSchema();
  reconcileStaleJobs();
  const where = type ? `AND type = '${type}'` : "";
  const r = sqlite.prepare(`SELECT * FROM jobs WHERE status IN ('queued','running','verifying','compiling') ${where} ORDER BY id DESC LIMIT 1`).get();
  return r ? rowToJob(r) : null;
}
