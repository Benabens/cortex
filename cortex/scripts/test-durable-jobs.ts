/**
 * Phase C — PREUVE « tue un worker en plein job → il reprend SANS PERTE ni doublon ».
 * Déterministe et gratuit (CORTEX_TEST_STUB_BATCH, aucun appel Max) :
 *
 *  1. crée un job 'exam' + lance un VRAI worker détaché avec CORTEX_TEST_DIE_AFTER_BATCH=0
 *     → le worker persiste le lot 0 dans jobs.checkpoint_json puis MEURT (exit 9) ;
 *  2. reconcileStaleJobs() → le job (PID mort) est RE-MIS EN FILE, attempts=1, checkpoint intact ;
 *  3. pumpQueuedJobs() (sans le crochet de mort) → un nouveau worker reprend : le lot 0 est lu
 *     du checkpoint (pas re-généré), seuls les lots restants sont produits ;
 *  4. vérifie : job 'done', examen complet (6/6 questions du blueprint ml), pas de doublon,
 *     checkpoint consommé, log « repris du checkpoint ».
 */
import { enterCourse } from "../db/client";
import { q } from "../db/q";
import { createJob, ensureJobsSchema, getJob, pumpQueuedJobs, reconcileStaleJobs, startWorker } from "../lib/jobs";

enterCourse("ml"); // cours de test isolé (mêmes conventions que test-resilience)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return;
    await sleep(500);
  }
  throw new Error(`Timeout en attendant : ${label}`);
}

(async () => {
  await ensureJobsSchema();
  await q.run(`DELETE FROM jobs WHERE type = 'exam'`); // isole le test
  // pré-check du worker : le corpus doit exister (le stub n'en lit pas le contenu)
  const items = (await q.get<{ n: number }>(`SELECT count(*) n FROM items`))?.n ?? 0;
  if (!items) {
    const sid = await q.insert(`INSERT INTO sources (type, title, path) VALUES ('note','seed-test','/seed')`);
    await q.run(`INSERT INTO items (source_id, type, text) VALUES (?,?,?)`, sid, "note", "seed corpus test durabilité");
  }

  // ── 1. worker qui MEURT après le lot 0 ──────────────────────────────────
  process.env.CORTEX_TEST_STUB_BATCH = "1";
  process.env.CORTEX_TEST_DIE_AFTER_BATCH = "0";
  const jobId = await createJob("exam");
  await startWorker(jobId, "ml");
  console.log(`Job #${jobId} lancé, le worker va mourir après le lot 0…`);

  await waitFor(async () => {
    const r = await q.get<{ checkpoint_json: string | null; pid: number | null }>(`SELECT checkpoint_json, pid FROM jobs WHERE id = ?`, jobId);
    if (!r?.checkpoint_json || !r.pid) return false;
    try { process.kill(r.pid, 0); return false; } catch { return true; } // checkpoint posé ET pid mort
  }, 60_000, "mort du worker après checkpoint du lot 0");
  const ck1 = await q.get<{ checkpoint_json: string }>(`SELECT checkpoint_json FROM jobs WHERE id = ?`, jobId);
  const batches1 = JSON.parse(ck1!.checkpoint_json).batches as unknown[][];
  const lot0 = batches1[0]?.length ?? 0;
  // (les lots tournent en parallèle : le lot 1 peut avoir été sauvé avant la mort — sans importance,
  //  l'essentiel est que la progression persistée survive et ne soit PAS rebrûlée à la reprise)
  console.log(`✓ Worker mort en plein job — checkpoint DB : lot 0 = ${lot0} question(s), lot 1 = ${batches1[1] ? "déjà sauvé" : "à reprendre"}`);
  if (!lot0) { console.log("❌ checkpoint inattendu (lot 0 absent)"); process.exit(1); }

  // ── 2. réconciliation → requeue avec checkpoint conservé ───────────────
  await reconcileStaleJobs();
  const afterRec = await q.get<{ status: string; attempts: number; checkpoint_json: string | null }>(
    `SELECT status, attempts, checkpoint_json FROM jobs WHERE id = ?`, jobId);
  const requeued = afterRec?.status === "queued" && afterRec.attempts === 1 && !!afterRec.checkpoint_json;
  console.log(`${requeued ? "✓" : "✗"} Réconciliation → status=${afterRec?.status}, attempts=${afterRec?.attempts}, checkpoint ${afterRec?.checkpoint_json ? "conservé" : "PERDU"}`);
  if (!requeued) process.exit(1);

  // ── 3. pompe (sans le crochet de mort) → reprise ────────────────────────
  delete process.env.CORTEX_TEST_DIE_AFTER_BATCH;
  await sleep(5_100); // la pompe laisse 5 s de grâce après le requeue
  const resumed = await pumpQueuedJobs();
  console.log(`✓ Pompe : ${resumed} worker(s) relancé(s)`);

  await waitFor(async () => (await getJob(jobId))?.status === "done", 120_000, "job repris → done");

  // ── 4. vérifications finales ────────────────────────────────────────────
  const job = (await getJob(jobId))!;
  const exam = await q.get<{ id: number }>(`SELECT result_id id FROM jobs WHERE id = ?`, jobId);
  const nq = (await q.get<{ n: number }>(`SELECT count(*) n FROM exam_questions WHERE exam_id = ?`, exam!.id))!.n;
  const dup = (await q.get<{ n: number }>(
    `SELECT count(*) - count(DISTINCT concept) n FROM exam_questions WHERE exam_id = ?`, exam!.id))!.n;
  const ckFinal = await q.get<{ checkpoint_json: string | null }>(`SELECT checkpoint_json FROM jobs WHERE id = ?`, jobId);
  const resumedFromCkpt = job.log.some((l) => /repris du checkpoint/.test(l.msg));

  const checks: [string, boolean][] = [
    [`job done (status=${job.status})`, job.status === "done"],
    [`examen complet (${nq} questions, 0 manquante)`, nq >= 6],
    [`aucun doublon de concept (${dup})`, Number(dup) === 0],
    [`lot 0 repris du checkpoint (pas re-généré)`, resumedFromCkpt],
    [`checkpoint consommé après succès`, !ckFinal?.checkpoint_json],
    [`une seule reprise (attempts=1)`, (await q.get<{ attempts: number }>(`SELECT attempts FROM jobs WHERE id = ?`, jobId))!.attempts === 1],
  ];
  let allOk = true;
  for (const [label, ok] of checks) { allOk = allOk && ok; console.log(`   ${ok ? "✓" : "✗"} ${label}`); }
  if (!allOk) {
    console.log("\n--- log du job (diagnostic) ---");
    for (const l of job.log) console.log("   ·", l.msg.slice(0, 110));
  }

  await q.run(`DELETE FROM jobs WHERE id = ?`, jobId);
  console.log(allOk
    ? "\n✅ Phase C OK : worker tué en plein job → requeue automatique, reprise au lot suivant, zéro perte, zéro doublon."
    : "\n❌ Phase C ÉCHEC");
  process.exit(allOk ? 0 : 1);
})();
