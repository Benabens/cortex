import { sqlite } from "@/db/client";
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
export type Job = {
  id: number;
  type: "exam" | "exercise";
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

export function createJob(type: "exam" | "exercise", target?: string): number {
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

export function getJob(id: number): Job | null {
  ensureJobsSchema();
  const r = sqlite.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
  return r ? rowToJob(r) : null;
}

export function listJobs(limit = 10): Job[] {
  ensureJobsSchema();
  return (sqlite.prepare(`SELECT * FROM jobs ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map(rowToJob);
}

/** Lance le worker DÉTACHÉ : il survit à la requête HTTP et au rechargement de page. */
export function startWorker(jobId: number) {
  const cwd = process.cwd();
  const tsxLocal = path.join(cwd, "node_modules", ".bin", "tsx");
  const useLocal = fs.existsSync(tsxLocal);
  const bin = useLocal ? tsxLocal : "npx";
  const args = useLocal ? ["scripts/run-job.ts", String(jobId)] : ["tsx", "scripts/run-job.ts", String(jobId)];
  const env = { ...process.env };
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
export function activeJob(type?: "exam" | "exercise"): Job | null {
  ensureJobsSchema();
  const where = type ? `AND type = '${type}'` : "";
  const r = sqlite.prepare(`SELECT * FROM jobs WHERE status IN ('queued','running','verifying','compiling') ${where} ORDER BY id DESC LIMIT 1`).get();
  return r ? rowToJob(r) : null;
}
