import { currentCourse, sqlite } from "@/db/client";
import { completeText, extractJson } from "@/lib/llm";
import { profile } from "@/lib/course-profile";
import { coursePaths } from "@/lib/courses";
import { sourceHref } from "@/lib/deeplink";
import { search } from "@/lib/search";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * V11 — INDEX EXHAUSTIF exo-par-exo des finals (remplace le résumé tronqué à 16 k).
 *
 * On parcourt CHAQUE final ENTIER (page par page, en vision — aucun cap), on extrait CHAQUE
 * exercice/sous-question, on le classe (topic/méthode/type/piège/archétype) et on calcule DEUX
 * deep-links : `exam_href` (la bonne page du PDF de l'exam) et `course_href` (le passage de cours
 * associé, via la recherche scopée). La partition `topics` est ensuite AGRÉGÉE depuis cet index
 * (vrais comptes → Strassen ×2 visible). Par cours, dans `exam_exercises` (DB du cours courant).
 */

export type ExamExercise = {
  id: number;
  examTitle: string;
  examYear: number | null;
  examPage: number | null;
  topic: string;
  method: string | null;
  exoType: string | null;
  trap: string | null;
  archetype: string | null;
  statement: string | null;
  points: number | null;
  examHref: string | null;
  courseHref: string | null;
  topicId: number | null;
};

export function ensureIndexSchema() {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS exam_exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_title TEXT,
    exam_year INTEGER,
    exam_page INTEGER,
    topic TEXT NOT NULL,
    method TEXT,
    exo_type TEXT,
    trap TEXT,
    archetype TEXT,
    statement TEXT,
    points REAL,
    exam_href TEXT,
    course_href TEXT,
    topic_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );`);
}

function pdftoppm(): string | null {
  for (const bin of ["pdftoppm", "/usr/bin/pdftoppm", "/opt/homebrew/bin/pdftoppm", "/usr/local/bin/pdftoppm"]) {
    try { execFileSync(bin, ["-v"], { stdio: "ignore" }); return bin; } catch { if (bin.includes("/") && fs.existsSync(bin)) return bin; }
  }
  return null;
}

/** Rend TOUTES les pages (jusqu'à maxPages) d'un PDF d'examen en PNG → {page, rel} (chemin rel au cwd). */
export function renderExamPages(course: string, refBasename: string, maxPages = 16): { page: number; rel: string }[] {
  const bin = pdftoppm();
  if (!bin) return [];
  const refsDir = coursePaths(course).refsDir;
  const pdf = path.join(refsDir, refBasename);
  if (!fs.existsSync(pdf)) return [];
  const outDir = path.join(refsDir, "figref-full");
  fs.mkdirSync(outDir, { recursive: true });
  const base = refBasename.replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "_");
  // (re)rend si pas déjà fait
  const existing = fs.readdirSync(outDir).filter((x) => x.startsWith(base + "-") && /\.png$/i.test(x));
  if (!existing.length) {
    try {
      execFileSync(bin, ["-png", "-r", "120", "-f", "1", "-l", String(maxPages), pdf, path.join(outDir, base)], { stdio: "ignore" });
    } catch { return []; }
  }
  return fs.readdirSync(outDir)
    .filter((x) => x.startsWith(base + "-") && /\.png$/i.test(x))
    .map((x) => {
      const m = x.match(/-(\d+)\.png$/i);
      return { page: m ? Number(m[1]) : 0, rel: path.relative(process.cwd(), path.join(outDir, x)) };
    })
    .filter((e) => e.page > 0)
    .sort((a, b) => a.page - b.page);
}

const EXO_SCHEMA = {
  type: "object",
  properties: {
    exercises: {
      type: "array",
      items: {
        type: "object",
        properties: {
          page: { type: "integer", description: "Numéro de page (1-based) où commence cet exercice." },
          topic: { type: "string", description: "Label COURT (EN, comme sur l'examen) du sujet/technique (ex. « Strassen / matrix multiplication », « Dijkstra shortest path », « DP — knapsack »)." },
          method: { type: "string", description: "La méthode/technique précise testée." },
          exo_type: { type: "string", description: "Le FORMAT réel de l'exo (QCM à réponse unique, preuve à rédiger, écrire un algo + complexité, remplir un tableau de DP, tracer un parcours…)." },
          trap: { type: "string", description: "Le piège typique / l'idée fausse punie, en une phrase (si visible)." },
          archetype: { type: "string", description: "L'id d'archétype le plus proche dans la liste fournie, ou \"\"." },
          statement: { type: "string", description: "Énoncé fidèle mais COURT (1-3 phrases) — de quoi reconnaître l'exo. Pas la solution." },
          points: { type: "number", description: "Barème de l'exo si indiqué, sinon 0." },
        },
        required: ["page", "topic", "method", "exo_type", "statement"],
        additionalProperties: false,
      },
    },
  },
  required: ["exercises"],
  additionalProperties: false,
} as const;

type RawExo = { page?: number; topic?: string; method?: string; exo_type?: string; trap?: string; archetype?: string; statement?: string; points?: number };

/** Construit le lien « passage de cours associé » : recherche scopée (topic+method) → meilleur hit de cours. */
function courseHrefFor(course: string, topic: string, method: string | null): string | null {
  try {
    const groups = search(`${topic} ${method ?? ""}`.trim(), 12, "or");
    const flat = groups.flatMap((g) => g.hits.map((h) => ({ ...h, sourceType: g.sourceType })));
    // priorité au matériel de COURS (slides/cours/review/site), pas aux finals eux-mêmes
    const PREF = ["course_pdf", "course", "cours", "review", "site", "serie", "cheatsheet"];
    const best = flat.filter((h) => PREF.includes(h.sourceType)).sort((a, b) => PREF.indexOf(a.sourceType) - PREF.indexOf(b.sourceType))[0]
      || flat.find((h) => h.sourceType !== "final" && h.sourceType !== "midterm");
    if (!best) return null;
    return sourceHref(course, best.sourcePath, best.anchor);
  } catch { return null; }
}

/** Indexe UN examen : rend ses pages, vision → chaque exo, calcule les 2 liens. Résilient (retourne []). */
async function indexOneExam(course: string, src: { path: string; title: string; year: number | null }, step: (m: string, p: number) => void, prog: number): Promise<Omit<ExamExercise, "id" | "topicId">[]> {
  const basename = path.basename(src.path);
  const pages = renderExamPages(course, basename);
  if (!pages.length) { step(`${src.title} : pages non rendues (ignoré)`, prog); return []; }
  const p = profile();
  const archetypeList = p.archetypes.map((a) => `  - id="${a.id}" · ${a.concept} (${a.topics.join(", ")})`).join("\n");
  const prompt = [
    p.qaIntro?.() ?? "Tu es l'équipe enseignante du cours.",
    `Voici TOUTES les pages d'UN vrai examen : « ${src.title} »${src.year ? ` (${src.year})` : ""}. Ouvre-les (outil Read) et lis l'examen EN ENTIER.`,
    ...pages.map((pg) => `  - page ${pg.page} : ${pg.rel}`),
    ``,
    `EXTRAIS CHAQUE exercice / problème / question (et sous-question si elle teste une technique distincte). N'en OUBLIE AUCUN. Pour chacun : la PAGE où il commence, un topic COURT (EN), la méthode, le format réel (exo_type), le piège, l'archétype le plus proche, un énoncé fidèle COURT, et le barème si indiqué.`,
    ``,
    `═══ ARCHÉTYPES (rattache via "archetype", "" si aucun) ═══`,
    archetypeList,
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON { "exercises": [ … ] }. Aucun texte autour.`,
    JSON.stringify(EXO_SCHEMA, null, 2),
  ].join("\n");
  const dirs = Array.from(new Set(pages.map((pg) => path.dirname(path.resolve(pg.rel)))));
  let raw: RawExo[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text = await completeText({ prompt, model: "opus", timeoutMs: 600_000, addDirs: dirs });
      const parsed = extractJson<{ exercises?: RawExo[] }>(text);
      raw = parsed?.exercises ?? [];
      if (raw.length) break;
    } catch (e) {
      step(`${src.title} : extraction échouée${attempt < 2 ? " — réessai" : " — ignoré"} (${(e as Error).message.slice(0, 50)})`, prog);
    }
  }
  const knownArche = new Set(p.archetypes.map((a) => a.id));
  const out: Omit<ExamExercise, "id" | "topicId">[] = [];
  for (const e of raw) {
    const topic = (e.topic ?? "").trim();
    if (!topic) continue;
    const page = Math.max(1, Math.round(Number(e.page) || 1));
    const method = (e.method ?? "").trim() || null;
    out.push({
      examTitle: src.title,
      examYear: src.year,
      examPage: page,
      topic: topic.slice(0, 160),
      method: method?.slice(0, 300) ?? null,
      exoType: (e.exo_type ?? "").slice(0, 200) || null,
      trap: (e.trap ?? "").slice(0, 400) || null,
      archetype: e.archetype && knownArche.has(e.archetype) ? e.archetype : null,
      statement: (e.statement ?? "").slice(0, 600) || null,
      points: Number(e.points) > 0 ? Number(e.points) : null,
      examHref: sourceHref(course, src.path, `${src.path}#page=${page}`),
      courseHref: courseHrefFor(course, topic, method),
    });
  }
  step(`${src.title} : ${out.length} exo(s) extraits`, prog);
  return out;
}

/** Garde un énoncé par année (évite de compter énoncé + corrigé → doublons faux). */
function pickEnonces(rows: { path: string; title: string; year: number | null }[]): typeof rows {
  const isSol = (s: string) => /solution|answer|grading|corrig|with\s+sol/i.test(s);
  const byYear = new Map<number, typeof rows>();
  const noYear: typeof rows = [];
  for (const r of rows) {
    if (r.year == null) { noYear.push(r); continue; }
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year)!.push(r);
  }
  const out: typeof rows = [];
  for (const [, group] of byYear) {
    const enonce = group.find((g) => !isSol(g.path) && !isSol(g.title));
    out.push(enonce ?? group[0]); // sinon le corrigé (seul dispo, ex. AnswersToFinal2011)
  }
  out.push(...noYear);
  return out.sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
}

export type IndexResult = { exams: number; exercises: number };

/** Indexe TOUS les finals/midterms du cours (un énoncé/an), exo par exo. Résilient. */
export async function indexExamExercises(opts: { onStep?: (m: string, p: number) => void } = {}): Promise<IndexResult> {
  ensureIndexSchema();
  const step = opts.onStep ?? (() => {});
  const course = currentCourse();
  const all = sqlite.prepare(`SELECT path, title, year FROM sources WHERE type IN ('final','midterm') GROUP BY path ORDER BY (year IS NULL), year`).all() as { path: string; title: string; year: number | null }[];
  const exams = pickEnonces(all);
  if (!exams.length) { step("Aucun final ingéré — index vide.", 100); return { exams: 0, exercises: 0 }; }
  sqlite.exec(`DELETE FROM exam_exercises`); // index reconstruit à chaque passe
  const ins = sqlite.prepare(`INSERT INTO exam_exercises (exam_title, exam_year, exam_page, topic, method, exo_type, trap, archetype, statement, points, exam_href, course_href) VALUES (@examTitle,@examYear,@examPage,@topic,@method,@exoType,@trap,@archetype,@statement,@points,@examHref,@courseHref)`);
  let total = 0;
  for (let i = 0; i < exams.length; i++) {
    const prog = 8 + Math.round((i / exams.length) * 82);
    step(`Indexation ${i + 1}/${exams.length} — ${exams[i].title}…`, prog);
    let rows: Omit<ExamExercise, "id" | "topicId">[] = [];
    try { rows = await indexOneExam(course, exams[i], step, prog); } catch (e) { step(`${exams[i].title} : ignoré (${(e as Error).message.slice(0, 50)})`, prog); }
    const tx = sqlite.transaction(() => { for (const r of rows) ins.run(r); });
    tx();
    total += rows.length;
  }
  step(`Index : ${total} exos sur ${exams.length} examens`, 92);
  return { exams: exams.length, exercises: total };
}

// ---------------- Requêtes sur l'index ----------------

export function indexStats(): { exercises: number; exams: number } {
  ensureIndexSchema();
  const exercises = (sqlite.prepare(`SELECT count(*) n FROM exam_exercises`).get() as { n: number }).n;
  const exams = (sqlite.prepare(`SELECT count(DISTINCT exam_title) n FROM exam_exercises`).get() as { n: number }).n;
  return { exercises, exams };
}

/** Les exos indexés rattachés à un type (par topic_id). */
export function exercisesForTopic(topicId: number): ExamExercise[] {
  ensureIndexSchema();
  return (sqlite.prepare(
    `SELECT id, exam_title examTitle, exam_year examYear, exam_page examPage, topic, method, exo_type exoType, trap, archetype, statement, points, exam_href examHref, course_href courseHref, topic_id topicId
     FROM exam_exercises WHERE topic_id = ? ORDER BY (exam_year IS NULL), exam_year, exam_page`
  ).all(topicId) as any[]).map((r) => ({ ...r }));
}
