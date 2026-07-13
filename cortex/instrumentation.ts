/**
 * V8 Phase 4 → Phase C — ZÉRO JOB ZOMBIE, ZÉRO RUN PERDU au démarrage du serveur.
 *
 * `register()` tourne UNE fois au boot (Next.js instrumentation). On balaie TOUTES les DB de cours
 * et on réconcilie les jobs « actifs » dont le worker (PID) est mort : un redémarrage du serveur
 * tue les workers détachés mais laisse leurs jobs en `running`.
 *
 * Phase C : la réconciliation RE-MET EN FILE les jobs interrompus (tant que attempts < max —
 * checkpoint conservé), puis la POMPE relance leurs workers : au boot, et toutes les 60 s
 * (filet quand personne ne regarde l'UI ; le polling des routes jobs pompe aussi).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // pas en edge runtime
  const g = globalThis as { __cortexJobsPump?: ReturnType<typeof setInterval> };
  try {
    const { runWithCourse } = await import("@/db/client");
    const { listCourses } = await import("@/lib/courses");
    const { reconcileStaleJobs, pumpQueuedJobs } = await import("@/lib/jobs");

    const sweep = async (): Promise<{ fixed: number; resumed: number }> => {
      let fixed = 0;
      let resumed = 0;
      for (const c of listCourses()) {
        try {
          fixed += await runWithCourse(c.id, () => reconcileStaleJobs());
          resumed += await runWithCourse(c.id, () => pumpQueuedJobs());
        } catch { /* DB du cours absente : rien à faire */ }
      }
      return { fixed, resumed };
    };

    const { fixed, resumed } = await sweep();
    if (fixed) console.log(`[instrumentation] ${fixed} job(s) interrompu(s) réconcilié(s) au démarrage.`);
    if (resumed) console.log(`[instrumentation] ${resumed} job(s) repris (workers relancés, checkpoint conservé).`);

    // Filet périodique (hot-reload safe : une seule minuterie par process).
    if (g.__cortexJobsPump) clearInterval(g.__cortexJobsPump);
    g.__cortexJobsPump = setInterval(() => {
      sweep().then(({ resumed: n }) => {
        if (n) console.log(`[instrumentation] ${n} job(s) repris par la pompe.`);
      }).catch(() => {});
    }, 60_000);
    g.__cortexJobsPump.unref?.();
  } catch (e) {
    console.error("[instrumentation] réconciliation des jobs ignorée :", (e as Error)?.message);
  }
}
