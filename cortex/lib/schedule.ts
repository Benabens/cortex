import { nowPlusDays, nowStr, q } from "@/db/q";

/**
 * Répétition espacée au niveau examen (courbe de l'oubli).
 * Les "concepts" sont dérivés des cartes review (sujets flagués par la prof).
 * Seeding idempotent : n'écrase jamais la progression existante.
 */

export async function ensureScheduleSeeded(): Promise<number> {
  await q.ensureTable("schedule");
  // Concepts = titres des cartes review (déjà ciblés sur les attendus de la prof)
  const concepts = await q.all<{ title: string }>(
    `SELECT DISTINCT title FROM items WHERE type = 'card' AND title IS NOT NULL AND length(title) > 4`
  );
  await q.tx(async () => {
    for (const c of concepts) {
      await q.run(`INSERT INTO schedule (concept, next_due_at) VALUES (?, NULL) ON CONFLICT DO NOTHING`, c.title);
    }
  });
  return (await q.get<{ n: number }>(`SELECT count(*) n FROM schedule`))!.n;
}

/** Concepts "dus" : jamais testés, ou dont l'échéance est passée. Les plus en retard d'abord. */
export async function dueConcepts(limit = 6): Promise<string[]> {
  await ensureScheduleSeeded();
  const rows = await q.all<{ concept: string }>(
    `SELECT concept FROM schedule
     WHERE next_due_at IS NULL OR next_due_at <= ?
     ORDER BY (next_due_at IS NOT NULL), next_due_at ASC
     LIMIT ?`,
    nowStr(),
    limit
  );
  return rows.map((r) => r.concept);
}

/** Marque des concepts comme testés : avance l'intervalle (SM-2 simplifié). */
export async function markTested(concepts: string[]): Promise<void> {
  await q.tx(async () => {
    for (const c of concepts) {
      const row = await q.get<{ interval_days: number; ease: number }>(
        `SELECT interval_days, ease FROM schedule WHERE concept = ?`,
        c
      );
      if (!row) {
        await q.run(
          `INSERT INTO schedule (concept, last_tested_at, interval_days, next_due_at)
           VALUES (?, ?, 3, ?)
           ON CONFLICT(concept) DO UPDATE SET
             last_tested_at = excluded.last_tested_at,
             interval_days = excluded.interval_days,
             next_due_at = excluded.next_due_at`,
          c,
          nowStr(),
          nowPlusDays(3)
        );
      } else {
        const next = Math.max(3, Math.round((row.interval_days || 1) * (row.ease || 2.5)));
        await q.run(
          `UPDATE schedule
           SET last_tested_at = ?, interval_days = ?, next_due_at = ?
           WHERE concept = ?`,
          nowStr(),
          next,
          nowPlusDays(next),
          c
        );
      }
    }
  });
}

export type ScheduleStat = { total: number; due: number };
export async function scheduleStats(): Promise<ScheduleStat> {
  await ensureScheduleSeeded();
  const total = (await q.get<{ n: number }>(`SELECT count(*) n FROM schedule`))!.n;
  const due = (
    await q.get<{ n: number }>(
      `SELECT count(*) n FROM schedule WHERE next_due_at IS NULL OR next_due_at <= ?`,
      nowStr()
    )
  )!.n;
  return { total, due };
}
