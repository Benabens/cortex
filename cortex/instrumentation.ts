/**
 * ZÉRO JOB ZOMBIE, ZÉRO RUN PERDU au démarrage du serveur.
 *
 * `register()` tourne UNE fois au boot (Next.js instrumentation). On balaie TOUTES les DB de cours
 * et on réconcilie les jobs « actifs » dont le worker (PID) est mort : un redémarrage du serveur
 * tue les workers détachés mais laisse leurs jobs en `running`.
 *
 * La réconciliation RE-MET EN FILE les jobs interrompus (tant que attempts < max —
 * checkpoint conservé), puis la POMPE relance leurs workers : au boot, et toutes les 60 s
 * (filet quand personne ne regarde l'UI ; le polling des routes jobs pompe aussi).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // pas en edge runtime
  // Même garde que prod-boot : un `next start` direct (hors entrypoint Docker)
  // en production ou avec facturation, sans AUTH_ENABLED=1, ne démarre pas —
  // chaque visiteur serait « owner ». Lève → Next refuse de servir.
  const { assertAuthRequired } = await import("@/lib/boot-guards");
  assertAuthRequired();
  const g = globalThis as { __cortexJobsPump?: ReturnType<typeof setInterval> };
  try {
    const { runWithCourse } = await import("@/db/client");
    const { runWithUser } = await import("@/db/context");
    const { ensureCoursesLoaded, listCourses } = await import("@/lib/courses");
    // Les cours vivent en base : en postgres, rien ne peut les lire de
    // façon synchrone → on remplit le cache ICI, avant la première requête.
    await ensureCoursesLoaded();
    const { reconcileStaleJobs, pumpQueuedJobs } = await import("@/lib/jobs");
    const { dbDriverName } = await import("@/db/q");

    const sweep = async (): Promise<{ fixed: number; resumed: number }> => {
      let fixed = 0;
      let resumed = 0;
      // Postgres multi-tenant : balaie les tenants CONNUS (registre public.tenants,
      // alimenté par ensureTenant) — sinon les jobs interrompus des users non-owner
      // ne seraient jamais repris après un redéploiement. SQLite : cours seuls
      // (mono-user owner, comportement historique).
      let tenants: Array<{ user_id: string; course: string }> = [];
      if (dbDriverName() === "postgres") {
        try {
          const { authAll } = await import("@/db/auth-store");
          tenants = await authAll<{ user_id: string; course: string }>(
            "SELECT user_id, course FROM tenants"
          );
        } catch { /* registre indisponible → balayage historique */ }
      }
      if (!tenants.length) tenants = listCourses().map((c) => ({ user_id: "", course: c.id }));
      for (const t of tenants) {
        const run = <T,>(fn: () => Promise<T>): Promise<T> =>
          t.user_id
            ? runWithUser(t.user_id, () => runWithCourse(t.course, fn))
            : runWithCourse(t.course, fn);
        try {
          fixed += await run(() => reconcileStaleJobs());
          resumed += await run(() => pumpQueuedJobs());
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
