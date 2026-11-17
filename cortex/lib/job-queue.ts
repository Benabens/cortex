import { authAll, authRun, authTx } from "@/db/auth-store";
import { dbDriverName } from "@/db/q";
import { intLimit } from "@/lib/billing/env";
import { log } from "@/lib/metrics";

/**
 * FILE GLOBALE DES WORKERS — plafond pour TOUTE l'instance, FIFO au-delà.
 *
 * MAX_ACTIVE_JOBS borne les générations d'UN compte ; chaque job est un process Node séparé
 * (lib/jobs startWorker) avec son propre LLM_MAX_CONCURRENCY. Sans plafond global, 30 comptes ×
 * 2 jobs = 60 process et jusqu'à 360 appels au modèle simultanés dans un seul conteneur : manque
 * de mémoire, ou vague de 429 qui fait échouer les jobs de tout le monde (audit du 14/11/2026,
 * n° 6). Ici, en base (table globale job_queue, comptée sous verrou) :
 *  - un job n'obtient un worker que si moins de MAX_GLOBAL_JOBS (défaut 4 en déploiement gardé)
 *    tournent ET qu'aucun job plus ancien n'attend : sinon il reste « queued », l'étudiant voit
 *    sa place dans la file ;
 *  - une place se libère à l'état terminal du job (setJob), ou d'elle-même quand le worker ne bat
 *    plus depuis HEARTBEAT_FRESH_MS (conteneur tué, worker planté) : pas de place perdue ;
 *  - dès qu'un worker sort, et toutes les 60 s (instrumentation), dispatchQueue démarre les
 *    suivants. Un job repris (zombie, arrêt gracieux) garde sa place d'origine : il repasse devant.
 * « unlimited » (ou dev sans garde-fous) : aucune file, aucune écriture.
 *
 * DEUX FILES (audit fuites B3) : les imports (« ingest », gratuits, CPU de pdftoppm et
 * d'extraction) ont leur propre plafond, MAX_GLOBAL_INGEST_JOBS (défaut 2), et ne prennent
 * jamais une place de MAX_GLOBAL_JOBS : une génération payée ne voit jamais d'import devant elle.
 * Chaque file a son FIFO et ses places ; une entrée sait la sienne (colonne `pool`). Dans la file
 * des imports, un compte ne tient qu'UNE place à la fois : ses autres imports attendent, et ceux
 * des autres comptes passent devant eux (20 cours relancés d'un coup ne bloquent personne).
 */

export type QueuePool = "gen" | "ingest";
export type QueueEntry = { user: string; course: string; jobId: number };
export type Admission = { admitted: true } | { admitted: false; position: number };

/** Workers de génération simultanés pour toute l'instance (null = sans plafond). */
export function maxGlobalJobs(): number | null {
  return intLimit("MAX_GLOBAL_JOBS", 4);
}

/** Imports simultanés pour toute l'instance, hors des places de génération (null = sans plafond). */
export function maxGlobalIngestJobs(): number | null {
  return intLimit("MAX_GLOBAL_INGEST_JOBS", 2);
}

const POOLS: QueuePool[] = ["gen", "ingest"];
const capOf = (pool: QueuePool) => (pool === "ingest" ? maxGlobalIngestJobs() : maxGlobalJobs());
/** File du type de job : l'import a la sienne, tout le reste (payé) partage l'autre. */
export const poolOfJobType = (type: string): QueuePool => (type === "ingest" ? "ingest" : "gen");
/** Aucune des deux files n'a de plafond : rien n'est écrit (dev sans garde-fous). */
const queueOff = () => POOLS.every((p) => capOf(p) === null);
/** Places d'une file qu'un même compte tient à la fois (null : pas de borne, MAX_ACTIVE_JOBS borne déjà les générations). */
const perUserCapOf = (pool: QueuePool): number | null => (pool === "ingest" ? 1 : null);

type QueueRow = { user_id: string; course: string; job_id: number; pool: QueuePool; state: string; started_at: string | null; heartbeat_at: string | null };
const sameEntry = (r: QueueRow, user: string, course: string, jobId: number) => r.user_id === user && r.course === course && Number(r.job_id) === jobId;
const runningLive = (r: QueueRow, fresh: string) => r.state === "running" && (r.heartbeat_at ?? r.started_at ?? "") >= fresh;

/**
 * Qui démarre parmi `candidates` (dans l'ordre de la file) quand `free` places sont libres :
 * les premiers, en sautant un compte qui tient déjà sa part de la file (`busy`, mis à jour).
 */
function eligibleHeads<T extends { user_id: string }>(candidates: T[], free: number, perUserCap: number | null, busy: Map<string, number>): T[] {
  const out: T[] = [];
  for (const c of candidates) {
    if (out.length >= free) break;
    const held = busy.get(c.user_id) ?? 0;
    if (perUserCap !== null && held >= perUserCap) continue;
    busy.set(c.user_id, held + 1);
    out.push(c);
  }
  return out;
}

/** Un worker qui a battu (ou démarré) il y a moins de ça occupe sa place (battement toutes les 30 s). */
const HEARTBEAT_FRESH_MS = 5 * 60_000;
/** Une entrée sans signe de vie depuis ça vient d'un job perdu de vue (tenant supprimé…). */
const STALE_ENTRY_MAX_AGE_MS = 48 * 3600_000;

/** Horodatage à la milliseconde : l'ordre FIFO ne se joue pas à la seconde près. */
function stamp(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 23).replace("T", " ");
}

const ORDER = "ORDER BY enqueued_at, user_id, course, job_id";

/**
 * Le job peut-il démarrer maintenant ? Inscrit le job dans la file s'il n'y est pas (sa place
 * d'origine est gardée s'il y est déjà), puis le passe « en cours » si une place est libre et
 * qu'il est en tête. Sinon, sa position dans la file (1 = le prochain).
 */
export async function admitJob(user: string, course: string, jobId: number, pool: QueuePool = "gen"): Promise<Admission> {
  const cap = capOf(pool);
  if (cap === null) return { admitted: true };
  return authTx(async (tx): Promise<Admission> => {
    if (dbDriverName() === "postgres") await tx.run(`SELECT pg_advisory_xact_lock(hashtext('cortex:job_queue'))`);
    const now = stamp();
    const fresh = stamp(-HEARTBEAT_FRESH_MS);
    // Entrées mortes depuis 48 h, en attente ou « en cours » sans battement : aucune ne compte
    // plus, mais sans purge la table grossirait (job jamais terminé côté tenant, tenant supprimé).
    await tx.run(`DELETE FROM job_queue WHERE COALESCE(heartbeat_at, enqueued_at) < ?`, stamp(-STALE_ENTRY_MAX_AGE_MS));
    await tx.run(
      `INSERT INTO job_queue (user_id, course, job_id, state, enqueued_at, pool) VALUES (?,?,?,'waiting',?,?) ON CONFLICT (user_id, course, job_id) DO NOTHING`,
      user, course, jobId, now, pool,
    );
    const mine = `user_id = ? AND course = ? AND job_id = ?`;
    const rows = await tx.all<QueueRow>(
      `SELECT user_id, course, job_id, pool, state, started_at, heartbeat_at FROM job_queue WHERE pool = ? OR (${mine}) ${ORDER}`, pool, user, course, jobId,
    );
    const others = rows.filter((r) => r.pool === pool && !sameEntry(r, user, course, jobId) && runningLive(r, fresh));
    const busy = new Map<string, number>();
    for (const r of others) busy.set(r.user_id, (busy.get(r.user_id) ?? 0) + 1);
    const free = Math.max(0, cap - others.length);
    // Candidats : les entrées en attente, plus celles « en cours » dont le worker est mort
    // (repris par la pompe) — dans l'ordre d'arrivée d'origine.
    const heads = rows.filter((r) => sameEntry(r, user, course, jobId) || (r.pool === pool && r.state === "waiting"));
    const at = heads.findIndex((h) => sameEntry(h, user, course, jobId));
    if (eligibleHeads(heads, free, perUserCapOf(pool), busy).some((h) => sameEntry(h, user, course, jobId))) {
      await tx.run(`UPDATE job_queue SET state = 'running', started_at = ?, heartbeat_at = ? WHERE ${mine}`, now, now, user, course, jobId);
      return { admitted: true };
    }
    await tx.run(`UPDATE job_queue SET state = 'waiting', heartbeat_at = NULL WHERE ${mine}`, user, course, jobId);
    return { admitted: false, position: at + 1 };
  });
}

/** Rend la place du job (état terminal). Best-effort : à défaut, elle se libère au battement périmé. */
export async function releaseJob(user: string, course: string, jobId: number): Promise<void> {
  if (queueOff()) return;
  await authRun(`DELETE FROM job_queue WHERE user_id = ? AND course = ? AND job_id = ?`, user, course, jobId)
    .catch((e) => log("warn", "jobs.queue_release_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
}

/** Job remis en file (reprise d'un zombie, arrêt gracieux) : sa place se libère, son rang d'arrivée reste. */
export async function requeueJob(user: string, course: string, jobId: number): Promise<void> {
  if (queueOff()) return;
  await authRun(`UPDATE job_queue SET state = 'waiting', heartbeat_at = NULL WHERE user_id = ? AND course = ? AND job_id = ?`, user, course, jobId)
    .catch(() => { /* best-effort : à défaut, la place se libère au battement périmé */ });
}

/** Battement du worker (scripts/run-job.ts, via heartbeatJob) : sa place reste occupée. */
export async function heartbeatQueuedJob(user: string, course: string, jobId: number): Promise<void> {
  if (queueOff()) return;
  await authRun(`UPDATE job_queue SET heartbeat_at = ? WHERE user_id = ? AND course = ? AND job_id = ? AND state = 'running'`, stamp(), user, course, jobId)
    .catch(() => { /* best-effort : un battement manqué sur cinq minutes ne coûte rien */ });
}

/** Les jobs en attente qui ont une place maintenant, file par file, chacune dans son ordre. */
export async function nextToStart(): Promise<QueueEntry[]> {
  const out: QueueEntry[] = [];
  const fresh = stamp(-HEARTBEAT_FRESH_MS);
  for (const pool of POOLS) {
    const cap = capOf(pool);
    if (cap === null) continue;
    const rows = await authAll<QueueRow>(`SELECT user_id, course, job_id, pool, state, started_at, heartbeat_at FROM job_queue WHERE pool = ? ${ORDER}`, pool);
    const live = rows.filter((r) => runningLive(r, fresh));
    const busy = new Map<string, number>();
    for (const r of live) busy.set(r.user_id, (busy.get(r.user_id) ?? 0) + 1);
    const free = Math.max(0, cap - live.length);
    if (!free) continue;
    const heads = eligibleHeads(rows.filter((r) => r.state === "waiting"), free, perUserCapOf(pool), busy);
    out.push(...heads.map((r) => ({ user: r.user_id, course: r.course, jobId: Number(r.job_id) })));
  }
  return out;
}

/** Démarre un job de la file dans son tenant (startWorker ré-admet, et ne lance qu'une fois). */
async function startQueued(e: QueueEntry): Promise<void> {
  const { runWithUser } = await import("@/db/context");
  const { runWithCourse } = await import("@/db/client");
  const { startWorker } = await import("@/lib/jobs");
  await runWithUser(e.user, () => runWithCourse(e.course, () => startWorker(e.jobId, e.course)));
}

/** Le job est-il encore en file dans son tenant ? (annulé, terminé, cours supprimé → non) */
async function stillQueued(e: QueueEntry): Promise<boolean> {
  const { runWithUser } = await import("@/db/context");
  const { runWithCourse } = await import("@/db/client");
  const { q } = await import("@/db/q");
  try {
    const row = await runWithUser(e.user, () => runWithCourse(e.course, () =>
      q.get<{ status: string; pid: number | null }>(`SELECT status, pid FROM jobs WHERE id = ?`, e.jobId)));
    return row?.status === "queued" && !row.pid;
  } catch {
    return false;
  }
}

/**
 * Démarre les jobs en tête de file tant qu'il y a des places. Une tête qui n'est plus en file
 * dans son tenant est retirée (sinon elle bloquerait tous les suivants). Rend le nombre démarré.
 */
export async function dispatchQueue(start: (e: QueueEntry) => Promise<void> = startQueued): Promise<number> {
  if (queueOff()) return 0;
  let started = 0;
  const seen = new Set<string>();
  for (let round = 0; round < 50; round++) {
    const heads = (await nextToStart()).filter((e) => !seen.has(`${e.user}\0${e.course}\0${e.jobId}`));
    if (!heads.length) break;
    for (const e of heads) {
      seen.add(`${e.user}\0${e.course}\0${e.jobId}`);
      if (!(await stillQueued(e))) {
        await releaseJob(e.user, e.course, e.jobId);
        continue;
      }
      try {
        await start(e);
        started++;
      } catch (err) {
        log("warn", "jobs.queue_start_failed", { message: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      }
    }
  }
  return started;
}
