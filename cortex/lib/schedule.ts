import { sqlite } from "@/db/client";

/**
 * Répétition espacée au niveau examen (courbe de l'oubli).
 * Les "concepts" sont dérivés des cartes review (sujets flagués par la prof).
 * Seeding idempotent : n'écrase jamais la progression existante.
 */

export function ensureScheduleSeeded(): number {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    concept TEXT NOT NULL UNIQUE,
    last_tested_at TEXT,
    interval_days INTEGER NOT NULL DEFAULT 1,
    next_due_at TEXT,
    ease REAL NOT NULL DEFAULT 2.5
  );`);
  // Concepts = titres des cartes review (déjà ciblés sur les attendus de la prof)
  const concepts = sqlite
    .prepare(
      `SELECT DISTINCT title FROM items WHERE type = 'card' AND title IS NOT NULL AND length(title) > 4`
    )
    .all() as { title: string }[];
  const ins = sqlite.prepare(`INSERT OR IGNORE INTO schedule (concept, next_due_at) VALUES (?, NULL)`);
  const tx = sqlite.transaction(() => {
    for (const c of concepts) ins.run(c.title);
  });
  tx();
  return (sqlite.prepare(`SELECT count(*) n FROM schedule`).get() as { n: number }).n;
}

/** Concepts "dus" : jamais testés, ou dont l'échéance est passée. Les plus en retard d'abord. */
export function dueConcepts(limit = 6): string[] {
  ensureScheduleSeeded();
  const rows = sqlite
    .prepare(
      `SELECT concept FROM schedule
       WHERE next_due_at IS NULL OR datetime(next_due_at) <= datetime('now')
       ORDER BY (next_due_at IS NOT NULL), datetime(next_due_at) ASC
       LIMIT ?`
    )
    .all(limit) as { concept: string }[];
  return rows.map((r) => r.concept);
}

/** Marque des concepts comme testés : avance l'intervalle (SM-2 simplifié). */
export function markTested(concepts: string[]) {
  const sel = sqlite.prepare(`SELECT interval_days, ease FROM schedule WHERE concept = ?`);
  const upd = sqlite.prepare(
    `UPDATE schedule
     SET last_tested_at = datetime('now'),
         interval_days = ?,
         next_due_at = datetime('now', '+' || ? || ' days')
     WHERE concept = ?`
  );
  const insUpd = sqlite.prepare(
    `INSERT INTO schedule (concept, last_tested_at, interval_days, next_due_at)
     VALUES (?, datetime('now'), 3, datetime('now', '+3 days'))
     ON CONFLICT(concept) DO UPDATE SET
       last_tested_at = excluded.last_tested_at,
       interval_days = excluded.interval_days,
       next_due_at = excluded.next_due_at`
  );
  const tx = sqlite.transaction(() => {
    for (const c of concepts) {
      const row = sel.get(c) as { interval_days: number; ease: number } | undefined;
      if (!row) {
        insUpd.run(c);
      } else {
        const next = Math.max(3, Math.round((row.interval_days || 1) * (row.ease || 2.5)));
        upd.run(next, next, c);
      }
    }
  });
  tx();
}

export type ScheduleStat = { total: number; due: number };
export function scheduleStats(): ScheduleStat {
  ensureScheduleSeeded();
  const total = (sqlite.prepare(`SELECT count(*) n FROM schedule`).get() as any).n;
  const due = (
    sqlite
      .prepare(
        `SELECT count(*) n FROM schedule WHERE next_due_at IS NULL OR datetime(next_due_at) <= datetime('now')`
      )
      .get() as any
  ).n;
  return { total, due };
}
