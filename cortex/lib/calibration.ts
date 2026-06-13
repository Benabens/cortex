import { currentCourse, sqlite } from "@/db/client";

/**
 * V5 Phase 3 — AUTO-APPRENTISSAGE (affinage piloté par les retours, pas un entraînement de modèle).
 *
 * L'app demande un retour après chaque exo (« au niveau d'un vrai final ? » → trop facile / juste /
 * pas le style de la prof / faux) ; on l'agrège PAR COURS × archétype (× topic) en une MÉMOIRE DE
 * CALIBRATION = des consignes APPRISES, injectées dans les prompts de l'architecte (conception du
 * piège + critique). Plus tu donnes de retours, plus les exos se rapprochent de ce que la prof pose.
 *
 * Table `feedback` créée EN LAZY dans la DB du cours courant (comme topics/mastery).
 */

export type Verdict = "too_easy" | "good" | "not_prof_style" | "wrong";
const VERDICTS: Verdict[] = ["too_easy", "good", "not_prof_style", "wrong"];

export function ensureFeedbackSchema() {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER,
    topic TEXT,
    archetype TEXT,
    verdict TEXT NOT NULL,
    note TEXT,
    score INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );`);
}

export function recordFeedback(input: { examId?: number | null; topic?: string | null; archetype?: string | null; verdict: string; note?: string | null; score?: number | null }): number {
  ensureFeedbackSchema();
  const verdict = VERDICTS.includes(input.verdict as Verdict) ? input.verdict : "good";
  return sqlite
    .prepare(`INSERT INTO feedback (exam_id, topic, archetype, verdict, note, score) VALUES (?,?,?,?,?,?)`)
    .run(input.examId ?? null, (input.topic ?? "").slice(0, 200) || null, input.archetype ?? null, verdict, (input.note ?? "").slice(0, 600) || null, input.score ?? null)
    .lastInsertRowid as number;
}

export type CalibrationLesson = { archetype: string | null; counts: Record<Verdict, number>; total: number; lessons: string[]; notes: string[] };

/** Agrège les retours du cours courant pour un archétype (et topic) → comptes + leçons + notes. */
export function calibrationFor(archetype?: string | null, topic?: string | null): CalibrationLesson {
  ensureFeedbackSchema();
  const where: string[] = [];
  const args: any[] = [];
  if (archetype) { where.push("archetype = ?"); args.push(archetype); }
  if (topic) { where.push("topic = ?"); args.push(topic); }
  const sql = `SELECT verdict, note FROM feedback ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY datetime(created_at) DESC LIMIT 40`;
  const rows = sqlite.prepare(sql).all(...args) as { verdict: string; note: string | null }[];
  const counts: Record<Verdict, number> = { too_easy: 0, good: 0, not_prof_style: 0, wrong: 0 };
  const notes: string[] = [];
  for (const r of rows) {
    if (VERDICTS.includes(r.verdict as Verdict)) counts[r.verdict as Verdict]++;
    if (r.note && r.note.trim()) notes.push(r.note.trim());
  }
  const total = rows.length;
  const lessons: string[] = [];
  if (total >= 1) {
    const tooEasyRate = counts.too_easy / total;
    const styleRate = counts.not_prof_style / total;
    const wrongRate = counts.wrong / total;
    if (tooEasyRate >= 0.34) lessons.push("L'étudiant a jugé ce type TROP FACILE par le passé → AUGMENTE nettement la densité de piège, la charge de bookkeeping et le nombre d'étapes ; sale les nombres ; rends le pattern-matcher franchement perdant.");
    if (styleRate >= 0.34) lessons.push("L'étudiant a jugé que ce type ne SONNE PAS comme la prof → rapproche-toi du phrasé exact (« justify », « state your assumptions », tables à remplir, sous-questions enchaînées, « explain why not / not enough info »).");
    if (wrongRate >= 0.34) lessons.push("Des exos de ce type ont été signalés FAUX → redouble de rigueur sur la JUSTESSE : re-résous chaque sous-question, vérifie les frontières/cas-limites, n'affirme rien d'invérifiable.");
    if (counts.good > 0 && tooEasyRate < 0.34 && styleRate < 0.34 && wrongRate < 0.34) lessons.push("Calibrage jugé bon par le passé sur ce type → garde ce niveau, ne baisse pas la difficulté.");
  }
  return { archetype: archetype ?? null, counts, total, lessons, notes: notes.slice(0, 6) };
}

/** Bloc de prompt « mémoire de calibration » à injecter dans l'architecte (vide si aucun retour). */
export function calibrationBlock(archetype?: string | null, topic?: string | null): string {
  const c = calibrationFor(archetype, topic);
  if (!c.total) return "";
  return [
    `═══ MÉMOIRE DE CALIBRATION (leçons APPRISES des retours de l'étudiant — APPLIQUE-LES) ═══`,
    `Retours passés sur ce type (${c.total}) : trop_facile=${c.counts.too_easy} · juste=${c.counts.good} · pas_le_style=${c.counts.not_prof_style} · faux=${c.counts.wrong}.`,
    ...c.lessons.map((l) => `  • ${l}`),
    ...(c.notes.length ? [`  Notes libres de l'étudiant à respecter : ${c.notes.map((n) => `« ${n} »`).join(" ; ")}`] : []),
  ].join("\n");
}

/** Retrouve l'archétype + le concept d'un exo généré (tag source_inspiration « architect:<id> »). */
export function resolveExamMeta(examId: number): { archetype: string | null; topic: string | null } {
  try {
    const r = sqlite.prepare(`SELECT concept, source_inspiration FROM exam_questions WHERE exam_id = ? LIMIT 1`).get(examId) as { concept: string; source_inspiration: string | null } | undefined;
    if (!r) return { archetype: null, topic: null };
    const m = (r.source_inspiration ?? "").match(/^architect:(.+)$/);
    return { archetype: m ? m[1] : null, topic: r.concept ?? null };
  } catch {
    return { archetype: null, topic: null };
  }
}

/** Récap « ce que j'ai appris de tes retours » (tous archétypes du cours courant). */
export function calibrationSummary(): { course: string; total: number; byArchetype: CalibrationLesson[] } {
  ensureFeedbackSchema();
  const archs = (sqlite.prepare(`SELECT DISTINCT archetype FROM feedback WHERE archetype IS NOT NULL`).all() as { archetype: string }[]).map((r) => r.archetype);
  const total = (sqlite.prepare(`SELECT count(*) n FROM feedback`).get() as { n: number }).n;
  return { course: currentCourse(), total, byArchetype: archs.map((a) => calibrationFor(a)).filter((c) => c.total > 0) };
}
