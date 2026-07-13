/**
 * V8 Phase 4 — ZÉRO JOB ZOMBIE au démarrage du serveur.
 *
 * `register()` tourne UNE fois au boot (Next.js instrumentation). On balaie TOUTES les DB de cours
 * et on réconcilie les jobs « actifs » dont le worker (PID) est mort : un redémarrage du serveur
 * tue les workers détachés mais laisse leurs jobs en `running` → ils resteraient « en file… » à vie.
 * Le polling de l'UI fait ensuite le heartbeat (lib/jobs.reconcileStaleJobs sur chaque lecture).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // pas en edge runtime
  try {
    const { runWithCourse } = await import("@/db/client");
    const { listCourses } = await import("@/lib/courses");
    const { reconcileStaleJobs } = await import("@/lib/jobs");
    let total = 0;
    for (const c of listCourses()) {
      try { total += await runWithCourse(c.id, () => reconcileStaleJobs()); } catch { /* DB du cours absente : rien à faire */ }
    }
    if (total) console.log(`[instrumentation] ${total} job(s) zombie réconcilié(s) au démarrage.`);
  } catch (e) {
    console.error("[instrumentation] réconciliation des jobs ignorée :", (e as Error)?.message);
  }
}
