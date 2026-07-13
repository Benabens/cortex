import { enterCourse } from "@/db/client";
import { q, nowStr } from "../db/q";
import { ensureJobsSchema, reconcileStaleJobs, getJob } from "@/lib/jobs";

(async () => {
enterCourse("algo"); // DB de test isolée (pas ml/cs-202)
await ensureJobsSchema();
// nettoie d'éventuels restes du test
await q.exec("DELETE FROM jobs WHERE target LIKE 'ZTEST%'");

// (1) job 'running' avec un PID MORT (999999 n'existe pas) → doit devenir 'error'
const deadPid = await q.insert("INSERT INTO jobs (type,target,status,current_step,progress,pid) VALUES ('exam','ZTEST-deadpid','running','En file…',20,999999)");
// (2) job 'queued' SANS pid mais VIEUX (>120s) → doit devenir 'error'
const tenMinAgo = nowStr(-10 * 60_000);
await q.run("INSERT INTO jobs (type,target,status,current_step,progress,pid,created_at,updated_at) VALUES ('qcm','ZTEST-nopid-old','queued','En file…',0,NULL,?,?)", tenMinAgo, tenMinAgo);
const oldNoPid = (await q.get<{id:number}>("SELECT id FROM jobs WHERE target='ZTEST-nopid-old'")) as {id:number};
// (3) job 'running' avec un PID VIVANT (le mien) → doit RESTER actif (pas touché)
const myPid = process.pid;
await q.run("INSERT INTO jobs (type,target,status,current_step,progress,pid) VALUES ('exam','ZTEST-alive','running','Appel Claude 10min…',45,?)", myPid);
const alive = (await q.get<{id:number}>("SELECT id FROM jobs WHERE target='ZTEST-alive'")) as {id:number};
// (4) job 'queued' SANS pid mais RÉCENT (<120s) → doit RESTER (worker en cours de spawn)
await q.run("INSERT INTO jobs (type,target,status,current_step,progress,pid) VALUES ('exam','ZTEST-nopid-fresh','queued','Démarrage…',0,NULL)");
const fresh = (await q.get<{id:number}>("SELECT id FROM jobs WHERE target='ZTEST-nopid-fresh'")) as {id:number};

console.log("Avant réconciliation :");
for (const t of ['ZTEST-deadpid','ZTEST-nopid-old','ZTEST-alive','ZTEST-nopid-fresh']) {
  const j = (await q.get("SELECT target,status FROM jobs WHERE target=?", t)) as any;
  console.log("  ",j.target,"=",j.status);
}
const n = await reconcileStaleJobs();
console.log(`\nreconcileStaleJobs() a corrigé ${n} job(s).\n`);
console.log("Après réconciliation :");
const expect: Record<string,string> = {[deadPid]:"error",[oldNoPid.id]:"error",[alive.id]:"running",[fresh.id]:"queued"};
let allOk = true;
for (const [tgt,id] of [["ZTEST-deadpid",deadPid],["ZTEST-nopid-old",oldNoPid.id],["ZTEST-alive",alive.id],["ZTEST-nopid-fresh",fresh.id]] as [string,number][]) {
  const j = (await getJob(id))!; const want = expect[id]; const ok = j.status===want;
  allOk = allOk && ok;
  console.log(`   ${ok?"✓":"✗"} ${tgt} → ${j.status} (attendu ${want})${j.error?` | "${j.error.slice(0,50)}"`:""}`);
}
await q.exec("DELETE FROM jobs WHERE target LIKE 'ZTEST%'");
console.log(allOk ? "\n✅ P4 OK : zombies (PID mort / sans-PID vieux) → error ; vivants/récents intacts." : "\n❌ P4 ÉCHEC");
process.exit(allOk?0:1);
})();
