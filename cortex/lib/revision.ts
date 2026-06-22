import { currentCourse, sqlite } from "@/db/client";
import { extractJson, runClaudeCode } from "@/lib/claude-code";
import { coursePaths } from "@/lib/courses";
import { sourceHref } from "@/lib/deeplink";
import { renderExamPages } from "@/lib/exam-index";
import fs from "node:fs";
import path from "node:path";

/**
 * RÉVISION (générique, additif) — banque EXHAUSTIVE de toutes les vraies questions des finals
 * (chaque QCM + chaque ouverte, par sujet, dans l'ordre du cours, avec proportions) PUIS un parcours
 * généré couvrant 100 % du programme. Lecture seule sur le moteur ; n'écrit que ses tables/exports.
 *
 * P1 (ce fichier) : `bank_questions` — index littéral question-par-question depuis les corrigés (vision).
 */

export type Kind = "qcm" | "open";
export type BankQuestion = {
  id: number; kind: Kind; topic: string; subtopic: string | null; statement: string;
  officialAnswer: string | null; options: string | null; sourceExam: string; examYear: number | null;
  examPage: number | null; points: number | null; lectureRank: number | null; examHref: string | null;
};

export function ensureRevisionSchema() {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS bank_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    topic TEXT NOT NULL,
    subtopic TEXT,
    statement TEXT NOT NULL,
    official_answer TEXT,
    options TEXT,
    source_exam TEXT,
    exam_year INTEGER,
    exam_page INTEGER,
    points REAL,
    lecture_rank INTEGER,
    exam_href TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );`);
  // parcours généré (questions NEUVES couvrant le programme) — réutilise qcm_items/exam_questions via examId.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS revision_plan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    topic TEXT NOT NULL,
    lecture_rank INTEGER,
    statement TEXT,
    options TEXT,
    correct TEXT,
    misconceptions TEXT,
    explanation TEXT,
    solution TEXT,
    verified INTEGER,
    verify_method TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );`);
}

// ─────────────────────── P1 — index exhaustif question-par-question ───────────────────────

const Q_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          page: { type: "integer", description: "Page (1-based) de la question." },
          kind: { type: "string", description: "qcm (à choix A-E) | open (à rédiger)." },
          topic: { type: "string", description: "Sujet COURT (EN) du cours (ex. « Linear regression », « PCA », « K-means », « Backpropagation »)." },
          subtopic: { type: "string", description: "Sous-sujet précis si pertinent." },
          statement: { type: "string", description: "Énoncé FIDÈLE (recopié/condensé) de la question (ou sous-question)." },
          options: { type: "string", description: "QCM uniquement : toutes les options, une par ligne (A) … B) … …). Vide pour open." },
          official_answer: { type: "string", description: "QCM : la/les LETTRE(S) correcte(s). Open : la conclusion / le résultat clé du corrigé." },
          points: { type: "number" },
        },
        required: ["page", "kind", "topic", "statement"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
} as const;

type RawQ = { page?: number; kind?: string; topic?: string; subtopic?: string; statement?: string; options?: string; official_answer?: string; points?: number };

/** Corrigés du cours (fichiers …with solutions / solutions / answers), un par année. */
function solutionRefs(): { path: string; title: string; year: number | null }[] {
  const rows = sqlite.prepare(`SELECT path, title, year FROM sources WHERE type IN ('final','midterm') GROUP BY path`).all() as { path: string; title: string; year: number | null }[];
  const isSol = (s: string) => /solution|answer|corrig/i.test(s);
  const byYear = new Map<string, { path: string; title: string; year: number | null }>();
  for (const r of rows) { if (!isSol(r.path) && !isSol(r.title)) continue; const k = String(r.year ?? r.path); if (!byYear.has(k)) byYear.set(k, r); }
  return [...byYear.values()].sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
}

type StepCb = (m: string, p: number) => void;

/** Indexe LITTÉRALEMENT chaque question de chaque corrigé (qcm + open). Résilient, exhaustif. */
export async function indexBank(opts: { onStep?: StepCb } = {}): Promise<{ exams: number; qcm: number; open: number }> {
  ensureRevisionSchema();
  const step = opts.onStep ?? (() => {});
  const course = currentCourse();
  const refs = solutionRefs();
  if (!refs.length) { step("Aucun corrigé ingéré.", 100); return { exams: 0, qcm: 0, open: 0 }; }
  sqlite.exec(`DELETE FROM bank_questions`);
  const ins = sqlite.prepare(`INSERT INTO bank_questions (kind, topic, subtopic, statement, official_answer, options, source_exam, exam_year, exam_page, points, exam_href) VALUES (@kind,@topic,@subtopic,@statement,@official,@options,@exam,@year,@page,@points,@href)`);
  let totQ = 0, totO = 0, examsUsed = 0;
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    const prog = 6 + Math.round((i / refs.length) * 80);
    const basename = path.basename(ref.path);
    // lien vers l'ÉNONCÉ (pas le corrigé) si dispo : enlève « _solutions/with solutions » du nom.
    const enonce = basename.replace(/[_ ]*(with )?solutions?/i, "").replace(/[_ ]*answers?/i, "");
    const refForLink = fs.existsSync(path.join(coursePaths(course).refsDir, enonce)) ? `refs/${enonce}` : ref.path;
    const pages = renderExamPages(course, basename, 24);
    if (!pages.length) { step(`${ref.title} : pages non rendues (ignoré)`, prog); continue; }
    const prompt = [
      `Voici TOUTES les pages d'un examen CORRIGÉ : « ${ref.title} »${ref.year ? ` (${ref.year})` : ""}. Ouvre-les (outil Read) — énoncés ET solutions officielles.`,
      ...pages.map((pg) => `  - page ${pg.page} : ${pg.rel}`),
      ``,
      `EXTRAIS LITTÉRALEMENT CHAQUE question de l'examen — CHAQUE QCM et CHAQUE question ouverte, y compris les sous-questions distinctes. N'EN OUBLIE AUCUNE (un examen ML a typiquement ~15-20 QCM + ~3 ouvertes). Pour chacune : page, kind (qcm/open), topic (sujet court EN), sous-sujet, énoncé fidèle, options complètes (QCM), et la réponse officielle (QCM : la/les lettre(s) ; open : la conclusion du corrigé).`,
      ``,
      `Réponds UNIQUEMENT avec { "questions": [ … ] } :`,
      JSON.stringify(Q_SCHEMA, null, 2),
    ].join("\n");
    const dirs = Array.from(new Set(pages.map((pg) => path.dirname(path.resolve(pg.rel)))));
    let raw: RawQ[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const parsed = extractJson<{ questions?: RawQ[] }>(await runClaudeCode({ prompt, model: "opus", timeoutMs: 600_000, addDirs: dirs }));
        raw = parsed?.questions ?? [];
        if (raw.length) break;
      } catch (e) { step(`${ref.title} : extraction ${attempt}/3 échouée (${(e as Error).message.slice(0, 40)})`, prog); }
    }
    let nq = 0, no = 0;
    const tx = sqlite.transaction(() => {
      for (const q of raw) {
        const kind: Kind = (q.kind ?? "").toLowerCase().startsWith("q") ? "qcm" : "open";
        const topic = (q.topic ?? "").trim(); const statement = (q.statement ?? "").trim();
        if (!topic || statement.length < 8) continue;
        const page = Math.max(1, Math.round(Number(q.page) || 1));
        ins.run({
          kind, topic: topic.slice(0, 120), subtopic: (q.subtopic ?? "").slice(0, 120) || null,
          statement: statement.slice(0, 1200), official: (q.official_answer ?? "").slice(0, 400) || null,
          options: kind === "qcm" ? (q.options ?? "").slice(0, 1500) || null : null,
          exam: ref.title, year: ref.year, page, points: Number(q.points) > 0 ? Number(q.points) : null,
          href: sourceHref(course, refForLink, `${refForLink}#page=${page}`),
        });
        if (kind === "qcm") nq++; else no++;
      }
    });
    tx();
    totQ += nq; totO += no; if (nq + no) examsUsed++;
    step(`${ref.title} : ${nq} QCM + ${no} ouvertes`, prog);
  }
  step(`Banque : ${totQ} QCM + ${totO} ouvertes sur ${examsUsed} finals`, 88);
  return { exams: examsUsed, qcm: totQ, open: totO };
}

// ─────────────────────── lecture_rank : sujet → n° de cours ───────────────────────

/** Mappe chaque topic distinct de la banque à un lecture_rank (ordre chronologique du cours). */
export async function assignLectureRanks(opts: { onStep?: StepCb } = {}): Promise<number> {
  ensureRevisionSchema();
  const step = opts.onStep ?? (() => {});
  const course = currentCourse();
  const topics = (sqlite.prepare(`SELECT DISTINCT topic FROM bank_questions ORDER BY topic`).all() as { topic: string }[]).map((r) => r.topic);
  if (!topics.length) return 0;
  // Approche robuste : on demande à Max d'ORDONNER les topics selon le déroulé du cours (titres de
  const lectureTitles = listLectureTitles(course);
  const prompt = [
    `Cours : Machine Learning (CS-233). Voici l'ordre des lectures (1 → ${lectureTitles.length}) :`,
    ...lectureTitles.map((t) => `  ${t.rank}. ${t.title}`),
    ``,
    `Pour CHAQUE sujet ci-dessous, donne le n° de lecture (lecture_rank) où il est enseigné en premier (1..${lectureTitles.length}). Si incertain, mets le plus plausible.`,
    ...topics.map((t, i) => `  ${i + 1}) ${t}`),
    ``,
    `Réponds UNIQUEMENT avec { "ranks": [ {"topic": "...", "lecture_rank": N}, … ] }.`,
  ].join("\n");
  step("Mappage sujet → ordre du cours…", 90);
  let ranks: { topic: string; lecture_rank?: number }[] = [];
  try { ranks = extractJson<{ ranks?: { topic: string; lecture_rank?: number }[] }>(await runClaudeCode({ prompt, model: "opus", timeoutMs: 180_000 }))?.ranks ?? []; } catch {}
  const map = new Map<string, number>();
  for (const r of ranks) if (r.topic) map.set(r.topic.trim().toLowerCase(), Math.max(1, Math.round(Number(r.lecture_rank) || 99)));
  const upd = sqlite.prepare(`UPDATE bank_questions SET lecture_rank = ? WHERE topic = ?`);
  let done = 0;
  const tx = sqlite.transaction(() => { for (const t of topics) { const lr = map.get(t.trim().toLowerCase()) ?? 99; upd.run(lr, t); if (lr < 99) done++; } });
  tx();
  step(`lecture_rank assigné à ${done}/${topics.length} sujets`, 95);
  return done;
}

/** Titres des lectures depuis le corpus ingéré (items de type course/slides), sinon noms de fichiers. */
function listLectureTitles(course: string): { rank: number; title: string }[] {
  const slidesDir = path.join(coursePaths(course).contentRoot, "slides");
  const out: { rank: number; title: string }[] = [];
  if (fs.existsSync(slidesDir)) {
    for (const f of fs.readdirSync(slidesDir)) {
      const m = f.match(/lecture[_ ]?(\d+)/i);
      if (m) out.push({ rank: Number(m[1]), title: f.replace(/\.pdf$/i, "") });
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}

// ─────────────────────── requêtes banque ───────────────────────

export function bankStats(): { qcm: number; open: number; byTopic: { topic: string; lectureRank: number | null; qcm: number; open: number }[] } {
  ensureRevisionSchema();
  const qcm = (sqlite.prepare(`SELECT count(*) n FROM bank_questions WHERE kind='qcm'`).get() as { n: number }).n;
  const open = (sqlite.prepare(`SELECT count(*) n FROM bank_questions WHERE kind='open'`).get() as { n: number }).n;
  const byTopic = sqlite.prepare(
    `SELECT topic, max(lecture_rank) lectureRank, sum(kind='qcm') qcm, sum(kind='open') open
     FROM bank_questions GROUP BY topic ORDER BY (lectureRank IS NULL), lectureRank, topic`
  ).all() as any[];
  return { qcm, open, byTopic: byTopic.map((r) => ({ ...r, lectureRank: r.lectureRank })) };
}

export function bankQuestions(kind?: Kind): BankQuestion[] {
  ensureRevisionSchema();
  const where = kind ? `WHERE kind = '${kind}'` : "";
  return (sqlite.prepare(
    `SELECT id, kind, topic, subtopic, statement, official_answer officialAnswer, options, source_exam sourceExam, exam_year examYear, exam_page examPage, points, lecture_rank lectureRank, exam_href examHref
     FROM bank_questions ${where} ORDER BY (lecture_rank IS NULL), lecture_rank, topic, exam_year, exam_page`
  ).all() as any[]).map((r) => ({ ...r }));
}

// ─────────────────────── parcours généré (P3) — requêtes ───────────────────────

export type PlanQuestion = { id: number; kind: Kind; topic: string; lectureRank: number | null; statement: string; options: string | null; correct: string | null; misconceptions: string | null; explanation: string | null; solution: string | null; verified: number | null; verifyMethod: string | null };

export function planQuestions(): PlanQuestion[] {
  ensureRevisionSchema();
  return (sqlite.prepare(
    `SELECT id, kind, topic, lecture_rank lectureRank, statement, options, correct, misconceptions, explanation, solution, verified, verify_method verifyMethod
     FROM revision_plan ORDER BY (lecture_rank IS NULL), lecture_rank, topic, id`
  ).all() as any[]).map((r) => ({ ...r }));
}

export function planStats(): { qcm: number; open: number; topics: number } {
  ensureRevisionSchema();
  const qcm = (sqlite.prepare(`SELECT count(*) n FROM revision_plan WHERE kind='qcm'`).get() as { n: number }).n;
  const open = (sqlite.prepare(`SELECT count(*) n FROM revision_plan WHERE kind='open'`).get() as { n: number }).n;
  const topics = (sqlite.prepare(`SELECT count(DISTINCT topic) n FROM revision_plan`).get() as { n: number }).n;
  return { qcm, open, topics };
}

// ─────────────────────── P4bis — export/chargement JSON (committé, portable) ───────────────────────

export type RevisionPayload = {
  course: string; generatedAt: string;
  bank: { stats: ReturnType<typeof bankStats>; qcm: BankQuestion[]; open: BankQuestion[] };
  plan: { stats: ReturnType<typeof planStats>; questions: PlanQuestion[] };
};

export function revisionPayload(): RevisionPayload {
  return {
    course: currentCourse(), generatedAt: new Date().toISOString(),
    bank: { stats: bankStats(), qcm: bankQuestions("qcm"), open: bankQuestions("open") },
    plan: { stats: planStats(), questions: planQuestions() },
  };
}

function jsonPath(course = currentCourse()): string {
  return path.join(coursePaths(course).dbPath.replace(/[^/]+$/, ""), `revision-${course}.json`);
}

/** Écrit la banque + le parcours dans un JSON COMMITTÉ (source de vérité portable, DB gitignorée). */
export function exportRevisionJson(): string {
  const file = jsonPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(revisionPayload(), null, 2));
  return file;
}

/** Charge le JSON committé (repli quand la DB du cours est vide chez l'utilisateur). */
export function loadRevisionJson(course = currentCourse()): RevisionPayload | null {
  try { const f = jsonPath(course); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; } catch { return null; }
}

