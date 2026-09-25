import { enterCourse } from "@/db/client";
import { q, nowStr } from "../db/q";
import { ensureJobsSchema, reconcileStaleJobs, getJob } from "@/lib/jobs";

/**
 * Contrat de la réconciliation des jobs interrompus.
 *  - Worker mort (PID mort / sans-PID vieux / heartbeat gelé) + budget restant → RE-MIS EN FILE
 *    (attempts+1, checkpoint CONSERVÉ) — la pompe le relancera.
 *  - Budget épuisé (attempts ≥ max_attempts) → 'error' (bouton réessayer).
 *  - PID vivant (sans heartbeat gelé) / sans-PID récent → INTACTS.
 */
(async () => {
enterCourse("algo"); // DB de test isolée (pas ml/cs-202)
await ensureJobsSchema();
await q.exec("DELETE FROM jobs WHERE target LIKE 'ZTEST%'");

const tenMinAgo = nowStr(-10 * 60_000);
const twentyMinAgo = nowStr(-20 * 60_000);

// (1) PID MORT, budget restant (0/2) + checkpoint → requeue attempts=1, checkpoint conservé
const deadPid = await q.insert(
  "INSERT INTO jobs (type,target,status,current_step,progress,pid,checkpoint_json) VALUES ('exam','ZTEST-deadpid','running','En file…',20,999999,'{\"batches\":[[1]]}')");
// (2) PID MORT, budget ÉPUISÉ (2/2) → error
const exhausted = await q.insert(
  "INSERT INTO jobs (type,target,status,current_step,progress,pid,attempts,max_attempts) VALUES ('exam','ZTEST-exhausted','running','…',20,999999,2,2)");
// (3) sans PID et VIEUX → requeue (budget restant)
await q.run("INSERT INTO jobs (type,target,status,current_step,progress,pid,created_at,updated_at) VALUES ('qcm','ZTEST-nopid-old','queued','En file…',0,NULL,?,?)", tenMinAgo, tenMinAgo);
const oldNoPid = (await q.get<{ id: number }>("SELECT id FROM jobs WHERE target='ZTEST-nopid-old'"))!;
// (4) PID VIVANT (le mien), heartbeat frais → intact
await q.run("INSERT INTO jobs (type,target,status,current_step,progress,pid,heartbeat_at) VALUES ('exam','ZTEST-alive','running','Appel LLM 10min…',45,?,?)", process.pid, nowStr());
const alive = (await q.get<{ id: number }>("SELECT id FROM jobs WHERE target='ZTEST-alive'"))!;
// (5) sans PID mais RÉCENT → intact (spawn en cours)
await q.run("INSERT INTO jobs (type,target,status,current_step,progress,pid) VALUES ('exam','ZTEST-nopid-fresh','queued','Démarrage…',0,NULL)");
const fresh = (await q.get<{ id: number }>("SELECT id FROM jobs WHERE target='ZTEST-nopid-fresh'"))!;
// (6) PID VIVANT mais HEARTBEAT GELÉ (20 min) → worker suspendu/PID recyclé → requeue
await q.run("INSERT INTO jobs (type,target,status,current_step,progress,pid,heartbeat_at) VALUES ('blueprint','ZTEST-stalled','running','Gelé…',30,?,?)", process.pid, twentyMinAgo);
const stalled = (await q.get<{ id: number }>("SELECT id FROM jobs WHERE target='ZTEST-stalled'"))!;

const n = await reconcileStaleJobs();
console.log(`reconcileStaleJobs() a traité ${n} job(s).\n`);

const expect: [string, number, string, number | null][] = [
  ["ZTEST-deadpid", deadPid, "queued", 1],
  ["ZTEST-exhausted", exhausted, "error", null],
  ["ZTEST-nopid-old", oldNoPid.id, "queued", 1],
  ["ZTEST-alive", alive.id, "running", null],
  ["ZTEST-nopid-fresh", fresh.id, "queued", 0],
  ["ZTEST-stalled", stalled.id, "queued", 1],
];
let allOk = true;
for (const [tgt, id, wantStatus, wantAttempts] of expect) {
  const j = (await getJob(id))!;
  const row = (await q.get<{ attempts: number; checkpoint_json: string | null }>("SELECT attempts, checkpoint_json FROM jobs WHERE id = ?", id))!;
  let ok = j.status === wantStatus && (wantAttempts === null || row.attempts === wantAttempts);
  if (tgt === "ZTEST-deadpid" && !row.checkpoint_json) ok = false; // le checkpoint doit SURVIVRE au requeue
  allOk = allOk && ok;
  console.log(`   ${ok ? "✓" : "✗"} ${tgt} → ${j.status} (attendu ${wantStatus})${wantAttempts !== null ? ` attempts=${row.attempts}/${wantAttempts}` : ""}${tgt === "ZTEST-deadpid" ? ` checkpoint=${row.checkpoint_json ? "conservé" : "PERDU"}` : ""}`);
}
await q.exec("DELETE FROM jobs WHERE target LIKE 'ZTEST%'");
console.log(allOk
  ? "\n✅ OK : interrompus → requeue borné avec checkpoint conservé ; budget épuisé → error ; vivants/récents intacts."
  : "\n❌ ÉCHEC");
process.exit(allOk ? 0 : 1);
})();
