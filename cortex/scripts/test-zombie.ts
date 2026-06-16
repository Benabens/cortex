import { enterCourse, sqlite } from "@/db/client";
import { ensureJobsSchema, reconcileStaleJobs, getJob } from "@/lib/jobs";

enterCourse("algo"); // DB de test isolée (pas ml/cs-202)
ensureJobsSchema();
// nettoie d'éventuels restes du test
sqlite.exec("DELETE FROM jobs WHERE target LIKE 'ZTEST%'");

// (1) job 'running' avec un PID MORT (999999 n'existe pas) → doit devenir 'error'
const deadPid = sqlite.prepare("INSERT INTO jobs (type,target,status,current_step,progress,pid) VALUES ('exam','ZTEST-deadpid','running','En file…',20,999999)").run().lastInsertRowid as number;
// (2) job 'queued' SANS pid mais VIEUX (>120s) → doit devenir 'error'
sqlite.prepare("INSERT INTO jobs (type,target,status,current_step,progress,pid,created_at,updated_at) VALUES ('qcm','ZTEST-nopid-old','queued','En file…',0,NULL,datetime('now','-10 minutes'),datetime('now','-10 minutes'))").run();
const oldNoPid = sqlite.prepare("SELECT id FROM jobs WHERE target='ZTEST-nopid-old'").get() as {id:number};
// (3) job 'running' avec un PID VIVANT (le mien) → doit RESTER actif (pas touché)
const myPid = process.pid;
sqlite.prepare("INSERT INTO jobs (type,target,status,current_step,progress,pid) VALUES ('exam','ZTEST-alive','running','Appel Claude 10min…',45,?)").run(myPid);
const alive = sqlite.prepare("SELECT id FROM jobs WHERE target='ZTEST-alive'").get() as {id:number};
// (4) job 'queued' SANS pid mais RÉCENT (<120s) → doit RESTER (worker en cours de spawn)
sqlite.prepare("INSERT INTO jobs (type,target,status,current_step,progress,pid) VALUES ('exam','ZTEST-nopid-fresh','queued','Démarrage…',0,NULL)").run();
const fresh = sqlite.prepare("SELECT id FROM jobs WHERE target='ZTEST-nopid-fresh'").get() as {id:number};

console.log("Avant réconciliation :");
for (const t of ['ZTEST-deadpid','ZTEST-nopid-old','ZTEST-alive','ZTEST-nopid-fresh']) {
  const j = sqlite.prepare("SELECT target,status FROM jobs WHERE target=?").get(t) as any;
  console.log("  ",j.target,"=",j.status);
}
const n = reconcileStaleJobs();
console.log(`\nreconcileStaleJobs() a corrigé ${n} job(s).\n`);
console.log("Après réconciliation :");
const expect: Record<string,string> = {[deadPid]:"error",[oldNoPid.id]:"error",[alive.id]:"running",[fresh.id]:"queued"};
let allOk = true;
for (const [tgt,id] of [["ZTEST-deadpid",deadPid],["ZTEST-nopid-old",oldNoPid.id],["ZTEST-alive",alive.id],["ZTEST-nopid-fresh",fresh.id]] as [string,number][]) {
  const j = getJob(id)!; const want = expect[id]; const ok = j.status===want;
  allOk = allOk && ok;
  console.log(`   ${ok?"✓":"✗"} ${tgt} → ${j.status} (attendu ${want})${j.error?` | "${j.error.slice(0,50)}"`:""}`);
}
sqlite.exec("DELETE FROM jobs WHERE target LIKE 'ZTEST%'");
console.log(allOk ? "\n✅ P4 OK : zombies (PID mort / sans-PID vieux) → error ; vivants/récents intacts." : "\n❌ P4 ÉCHEC");
process.exit(allOk?0:1);
