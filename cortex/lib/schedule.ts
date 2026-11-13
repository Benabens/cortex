import { nowPlusDays, nowStr, q } from "@/db/q";
import { isExamLogistics } from "@/lib/course-grounding";

/**
 * Répétition espacée au niveau examen (courbe de l'oubli).
 * Les "concepts" sont dérivés des cartes review (sujets flagués par la prof).
 * Seeding idempotent : n'écrase jamais la progression existante.
 * Une note de modalités d'examen (format, durée, barème…) n'est JAMAIS un concept :
 * ni semée, ni rendue due, ni marquée testée (isExamLogistics, COURSE_MATTER_RULE).
 */

export async function ensureScheduleSeeded(): Promise<number> {
  await q.ensureTable("schedule");
  // Concepts = titres des cartes review (déjà ciblés sur les attendus de la prof)
  // …hors consignes d'examen déposées comme telles (exam-info), et hors titres de modalités.
  const concepts = (await q.all<{ title: string }>(
    `SELECT DISTINCT i.title FROM items i LEFT JOIN sources s ON s.id = i.source_id
     WHERE i.type = 'card' AND i.title IS NOT NULL AND length(i.title) > 4 AND (s.type IS NULL OR s.type <> 'exam_info')`
  )).filter((c) => !isExamLogistics(c.title));
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
  // Filtré après lecture : une ligne semée avant la règle (purgée à la re-préparation) ne remonte déjà plus.
  const rows = await q.all<{ concept: string }>(
    `SELECT concept FROM schedule
     WHERE next_due_at IS NULL OR next_due_at <= ?
     ORDER BY (next_due_at IS NOT NULL), next_due_at ASC`,
    nowStr()
  );
  return rows.map((r) => r.concept).filter((c) => !isExamLogistics(c)).slice(0, limit);
}

/** Retire du planning les concepts qui sont des notes de modalités d'examen (à la (re)préparation du cours). */
export async function purgeExamLogisticsConcepts(): Promise<number> {
  await q.ensureTable("schedule");
  const bad = (await q.all<{ concept: string }>(`SELECT concept FROM schedule`)).filter((r) => isExamLogistics(r.concept));
  if (!bad.length) return 0;
  await q.tx(async () => {
    for (const r of bad) await q.run(`DELETE FROM schedule WHERE concept = ?`, r.concept);
  });
  return bad.length;
}

/** Marque des concepts comme testés : avance l'intervalle (SM-2 simplifié). */
export async function markTested(concepts: string[]): Promise<void> {
  await q.tx(async () => {
    for (const c of concepts.filter((x) => !isExamLogistics(x))) {
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
