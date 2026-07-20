import { currentCourse } from "@/db/client";
import { q } from "@/db/q";
import { completeText, extractJson } from "@/lib/llm";
import { profile } from "@/lib/course-profile";
import { pickEnonces, renderExamPages } from "@/lib/exam-index";
import {
  MOLD_KINDS,
  moldTaxonomyBlock,
  normalizeMold,
  normalizeFigureKind,
  figureKindKey,
  type MoldKind,
} from "@/lib/molds";
import path from "node:path";

/**
 * moteur-v2 (P0) — « ADN D'EXAMEN » détecté PAR COURS, depuis SES annales. 100 % générique :
 * aucun mot-clé de matière ici ; tout vient du modèle qui observe les vraies annales du cours.
 *
 *  1. MOULES  : chaque exercice indexé (exam_exercises) est classé dans la taxonomie générique
 *     (lib/molds.ts) → distribution RÉELLE des moules (proportions). Ré-entrant (WHERE mold IS NULL).
 *  2. FIGURES : passe VISION sur les pages rendues de chaque annale → liste des figures
 *     {page, kind générique, ce qu'elle montre (spec paramétrique)} → fréquences + specs.
 *     Ré-entrant (progression par examen persistée dans le blob).
 *  3. DIFFICULTÉ : texture (nombres non-ronds, sous-questions en escalier, pièges typiques)
 *     dérivée d'un échantillon de VRAIS énoncés.
 *
 * Persistance : table `exam_dna` (une ligne, blob JSON versionné) dans la DB du cours courant.
 * Un cours sans annale scannable → figures vides (honnête, jamais forcé).
 */

export type DnaMoldStat = { mold: MoldKind; count: number; share_pct: number };
export type DnaFigureKind = { kind: string; count: number; shows: string[] };
export type DnaScannedExam = {
  pages: number;
  figures: { page: number; kind: string; shows: string }[];
};

export type ExamDna = {
  version: 1;
  course: string;
  /** Distribution réelle des moules (sur les exos classés). */
  molds: DnaMoldStat[];
  figures: {
    kinds: DnaFigureKind[];
    pages_scanned: number;
    pages_with_figures: number;
    /** % de pages d'annales portant ≥ 1 figure. */
    figure_share_pct: number;
    /** % d'exercices dont l'énoncé référence une figure. */
    exercises_with_figure_pct: number;
    /** Progression par examen (ré-entrance) — titre → scan. */
    scanned: Record<string, DnaScannedExam>;
  };
  difficulty: {
    summary: string;
    non_round_numbers: boolean | null;
    staircase_subquestions: boolean | null;
    typical_traps: string[];
  } | null;
  totals: { exercises: number; classified: number };
  detected_at: string;
};

export async function ensureDnaSchema(): Promise<void> {
  await q.ensureTable("exam_exercises");
  await q.ensureColumns("exam_exercises", ["mold", "figure_kind"]);
  await q.ensureTable("exam_dna");
}

function emptyDna(course: string): ExamDna {
  return {
    version: 1,
    course,
    molds: [],
    figures: {
      kinds: [],
      pages_scanned: 0,
      pages_with_figures: 0,
      figure_share_pct: 0,
      exercises_with_figure_pct: 0,
      scanned: {},
    },
    difficulty: null,
    totals: { exercises: 0, classified: 0 },
    detected_at: "",
  };
}

/** Dernier ADN persisté du cours courant (null si jamais détecté). */
export async function getExamDna(): Promise<ExamDna | null> {
  await ensureDnaSchema();
  const r = await q.get<{ json: string }>(`SELECT json FROM exam_dna ORDER BY id DESC LIMIT 1`);
  if (!r?.json) return null;
  try { return JSON.parse(r.json) as ExamDna; } catch { return null; }
}

async function saveDna(dna: ExamDna): Promise<void> {
  await ensureDnaSchema();
  await q.tx(async () => {
    await q.exec(`DELETE FROM exam_dna`);
    await q.run(`INSERT INTO exam_dna (json) VALUES (?)`, JSON.stringify(dna));
  });
}

type Step = (m: string, p: number) => void;

// ---------------- 1. Classification des MOULES (texte, ré-entrant) ----------------

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    classified: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          mold: { type: "string", description: `Un moule EXACT parmi : ${MOLD_KINDS.join(" | ")}.` },
          figure_kind: {
            type: ["string", "null"],
            description:
              "Si l'énoncé RÉFÉRENCE une figure/diagramme/table/graphe fourni : libellé court GÉNÉRIQUE en anglais (ex. « plot », « diagram », « table », « tree », « graph », « state machine », « curve »… précisé librement). Sinon null.",
          },
        },
        required: ["id", "mold"],
        additionalProperties: false,
      },
    },
  },
  required: ["classified"],
  additionalProperties: false,
} as const;

type RawClassified = { id?: number; mold?: string; figure_kind?: string | null };

/** Classe chaque exo indexé NON ENCORE classé dans un moule (batchs, résilient, ré-entrant). */
export async function classifyMolds(step: Step = () => {}): Promise<{ classified: number; remaining: number }> {
  await ensureDnaSchema();
  const rows = await q.all<{ id: number; exo_type: string | null; topic: string; statement: string | null; points: number | null }>(
    `SELECT id, exo_type, topic, statement, points FROM exam_exercises WHERE mold IS NULL ORDER BY id`
  );
  if (!rows.length) {
    const done = (await q.get<{ n: number }>(`SELECT count(*) n FROM exam_exercises WHERE mold IS NOT NULL`))?.n ?? 0;
    step(`Moules : déjà classés (${done})`, 100);
    return { classified: 0, remaining: 0 };
  }
  const p = profile();
  const BATCH = 24;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    step(`Moules : classification ${i + 1}-${Math.min(i + BATCH, rows.length)}/${rows.length}…`, Math.round((i / rows.length) * 100));
    const prompt = [
      p.qaIntro?.() ?? "Tu es l'équipe enseignante du cours.",
      `Voici la TAXONOMIE GÉNÉRIQUE des MOULES de questions d'examen :`,
      moldTaxonomyBlock(),
      ``,
      `Voici des exercices RÉELS extraits des annales de CE cours. Classe CHACUN dans EXACTEMENT UN moule`,
      `(le moule DOMINANT si l'exo en mélange plusieurs), et signale si l'énoncé fait référence à une figure fournie.`,
      ``,
      ...batch.map((r) =>
        `  - id=${r.id} · [format observé : ${r.exo_type ?? "?"}] · ${(r.statement ?? r.topic).replace(/\s+/g, " ").slice(0, 300)}`
      ),
      ``,
      `Réponds UNIQUEMENT avec { "classified": [ { "id", "mold", "figure_kind" }, … ] } couvrant TOUS les ids.`,
      JSON.stringify(CLASSIFY_SCHEMA, null, 2),
    ].join("\n");
    let raw: RawClassified[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const parsed = extractJson<{ classified?: RawClassified[] }>(
          await completeText({ prompt, model: "opus", timeoutMs: 300_000 })
        );
        raw = parsed?.classified ?? [];
        if (raw.length) break;
      } catch (e) {
        step(`Moules : lot ${i / BATCH + 1} échoué${attempt < 2 ? " — réessai" : " — ignoré (repris au prochain run)"} (${(e as Error).message.slice(0, 40)})`, Math.round((i / rows.length) * 100));
      }
    }
    const ids = new Set(batch.map((b) => b.id));
    await q.tx(async () => {
      for (const c of raw) {
        if (typeof c.id !== "number" || !ids.has(c.id)) continue;
        const mold = normalizeMold(c.mold);
        if (!mold) continue; // hors taxonomie → reste NULL (repris plus tard), jamais forcé
        await q.run(
          `UPDATE exam_exercises SET mold = ?, figure_kind = ? WHERE id = ?`,
          mold, normalizeFigureKind(c.figure_kind), c.id
        );
        done++;
      }
    });
  }
  const remaining = (await q.get<{ n: number }>(`SELECT count(*) n FROM exam_exercises WHERE mold IS NULL`))?.n ?? 0;
  step(`Moules : ${done} classés, ${remaining} restants ✓`, 100);
  return { classified: done, remaining };
}

// ---------------- 2. Scan VISION des FIGURES (par examen, ré-entrant) ----------------

const FIG_SCAN_SCHEMA = {
  type: "object",
  properties: {
    figures: {
      type: "array",
      items: {
        type: "object",
        properties: {
          page: { type: "integer", description: "Page (1-based) où la figure apparaît." },
          kind: { type: "string", description: "Type de figure : libellé court GÉNÉRIQUE en anglais (ex. « plot », « function curve », « diagram », « tree », « state machine », « table », « grid », « circuit »… librement précisé d'après ce que tu VOIS)." },
          shows: { type: "string", description: "Ce que la figure montre, en 1 phrase PARAMÉTRIQUE (les quantités/axes/éléments variables), pas le contenu littéral." },
        },
        required: ["page", "kind", "shows"],
        additionalProperties: false,
      },
    },
  },
  required: ["figures"],
  additionalProperties: false,
} as const;

type RawFig = { page?: number; kind?: string; shows?: string };

/** Scanne (vision) les figures de chaque annale non encore scannée ; progression persistée par examen. */
export async function scanFigures(step: Step = () => {}): Promise<ExamDna> {
  await ensureDnaSchema();
  const course = currentCourse();
  const dna = (await getExamDna()) ?? emptyDna(course);
  const all = await q.all<{ path: string; title: string; year: number | null }>(
    `SELECT path, title, year FROM sources WHERE type IN ('final','midterm') GROUP BY path ORDER BY (year IS NULL), year`
  );
  const exams = pickEnonces(all);
  if (!exams.length) { step("Figures : aucune annale — scan vide.", 100); return dna; }
  const p = profile();
  const todo = exams.filter((e) => !(e.title in dna.figures.scanned));
  let i = 0;
  for (const exam of todo) {
    i++;
    const pct = Math.round((i / Math.max(1, todo.length)) * 100);
    const pages = renderExamPages(course, path.basename(exam.path));
    if (!pages.length) {
      // non scannable (HTML / pdftoppm absent) → compté honnêtement à 0 page, jamais inventé.
      dna.figures.scanned[exam.title] = { pages: 0, figures: [] };
      await saveDna(dna);
      step(`Figures : ${exam.title} non scannable (pas de pages rendues)`, pct);
      continue;
    }
    step(`Figures : scan ${i}/${todo.length} — ${exam.title} (${pages.length} p.)…`, pct);
    const prompt = [
      p.qaIntro?.() ?? "Tu es l'équipe enseignante du cours.",
      `Voici TOUTES les pages d'une VRAIE annale : « ${exam.title} ». Ouvre-les (outil Read) et observe-les.`,
      ...pages.map((pg) => `  - page ${pg.page} : ${pg.rel}`),
      ``,
      `LISTE CHAQUE FIGURE visible (dessin, courbe, nuage de points, diagramme, graphe, arbre, automate,`,
      `table/grille à remplir, matrice, circuit, chronogramme…). N'invente rien : uniquement ce qui est VISIBLE.`,
      `Ignore les logos/en-têtes. Pour chaque figure : la page, un "kind" court générique (EN), et "shows" =`,
      `ce qu'elle montre en 1 phrase PARAMÉTRIQUE (axes/quantités/éléments), réutilisable pour générer une figure du même type.`,
      ``,
      `Réponds UNIQUEMENT avec { "figures": [ … ] } (tableau vide si aucune figure).`,
      JSON.stringify(FIG_SCAN_SCHEMA, null, 2),
    ].join("\n");
    const dirs = Array.from(new Set(pages.map((pg) => path.dirname(path.resolve(pg.rel)))));
    let figs: { page: number; kind: string; shows: string }[] = [];
    let ok = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const parsed = extractJson<{ figures?: RawFig[] }>(
          await completeText({ prompt, model: "opus", timeoutMs: 600_000, addDirs: dirs })
        );
        figs = (parsed?.figures ?? [])
          .map((f) => ({
            page: Math.max(1, Math.round(Number(f.page) || 1)),
            kind: normalizeFigureKind(f.kind) ?? "",
            shows: (f.shows ?? "").replace(/\s+/g, " ").trim().slice(0, 180),
          }))
          .filter((f) => f.kind);
        ok = true;
        break;
      } catch (e) {
        step(`Figures : ${exam.title} échoué${attempt < 2 ? " — réessai" : " — repris au prochain run"} (${(e as Error).message.slice(0, 40)})`, pct);
      }
    }
    if (!ok) continue; // pas marqué scanné → ré-entrant
    dna.figures.scanned[exam.title] = { pages: pages.length, figures: figs };
    await saveDna(dna);
    step(`Figures : ${exam.title} → ${figs.length} figure(s)`, pct);
  }
  return dna;
}

// ---------------- 3. Agrégation + texture de difficulté ----------------

const DIFF_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "2-3 phrases : la texture de difficulté typique de ces annales (multi-étapes ? calculs ? pièges ?)." },
    non_round_numbers: { type: "boolean", description: "Les valeurs numériques sont-elles typiquement non-rondes ?" },
    staircase_subquestions: { type: "boolean", description: "Les questions procèdent-elles par sous-questions en escalier (a) → b) → c)) ?" },
    typical_traps: { type: "array", items: { type: "string" }, description: "≤ 6 pièges TYPIQUES observés (1 phrase chacun)." },
  },
  required: ["summary", "non_round_numbers", "staircase_subquestions", "typical_traps"],
  additionalProperties: false,
} as const;

/** Agrège moules + figures + texture → persiste l'ADN complet. */
export async function aggregateDna(step: Step = () => {}): Promise<ExamDna> {
  await ensureDnaSchema();
  const course = currentCourse();
  const dna = (await getExamDna()) ?? emptyDna(course);
  dna.course = course;

  // — moules —
  const moldRows = await q.all<{ mold: string; n: number }>(
    `SELECT mold, count(*) n FROM exam_exercises WHERE mold IS NOT NULL GROUP BY mold ORDER BY n DESC`
  );
  const totals = await q.get<{ total: number; classified: number; withFig: number }>(
    `SELECT count(*) total, count(mold) classified, sum(CASE WHEN figure_kind IS NOT NULL THEN 1 ELSE 0 END) withFig FROM exam_exercises`
  );
  const classified = totals?.classified ?? 0;
  dna.totals = { exercises: totals?.total ?? 0, classified };
  dna.molds = moldRows
    .map((r) => ({ mold: normalizeMold(r.mold), count: r.n }))
    .filter((r): r is { mold: MoldKind; count: number } => r.mold != null)
    .map((r) => ({ ...r, share_pct: classified ? Math.round((r.count / classified) * 1000) / 10 : 0 }));

  // — figures (fusion par clé normalisée, libellé représentatif = le plus fréquent) —
  const byKey = new Map<string, { labels: Map<string, number>; count: number; shows: string[] }>();
  let pagesScanned = 0;
  const pagesWithFig = new Set<string>();
  for (const [title, scan] of Object.entries(dna.figures.scanned)) {
    pagesScanned += scan.pages;
    for (const f of scan.figures) {
      pagesWithFig.add(`${title}#${f.page}`);
      const k = figureKindKey(f.kind);
      if (!k) continue;
      let e = byKey.get(k);
      if (!e) { e = { labels: new Map(), count: 0, shows: [] }; byKey.set(k, e); }
      e.count++;
      e.labels.set(f.kind, (e.labels.get(f.kind) ?? 0) + 1);
      if (f.shows && e.shows.length < 3 && !e.shows.includes(f.shows)) e.shows.push(f.shows);
    }
  }
  dna.figures.kinds = [...byKey.values()]
    .map((e) => ({
      kind: [...e.labels.entries()].sort((a, b) => b[1] - a[1])[0][0],
      count: e.count,
      shows: e.shows,
    }))
    .sort((a, b) => b.count - a.count);
  dna.figures.pages_scanned = pagesScanned;
  dna.figures.pages_with_figures = pagesWithFig.size;
  dna.figures.figure_share_pct = pagesScanned ? Math.round((pagesWithFig.size / pagesScanned) * 1000) / 10 : 0;
  dna.figures.exercises_with_figure_pct = dna.totals.exercises
    ? Math.round(((totals?.withFig ?? 0) / dna.totals.exercises) * 1000) / 10
    : 0;

  // — texture de difficulté (échantillon de vrais énoncés + pièges déjà minés) —
  step("Texture de difficulté (échantillon d'énoncés réels)…", 80);
  try {
    const sample = await q.all<{ statement: string; points: number | null }>(
      `SELECT statement, points FROM exam_exercises WHERE statement IS NOT NULL ORDER BY (exam_year IS NULL), exam_year DESC, id LIMIT 18`
    );
    const traps = await q.all<{ trap: string }>(
      `SELECT DISTINCT trap FROM exam_exercises WHERE trap IS NOT NULL AND trap != '' LIMIT 12`
    );
    if (sample.length >= 4) {
      const p = profile();
      const prompt = [
        p.qaIntro?.() ?? "Tu es l'équipe enseignante du cours.",
        `Voici un échantillon d'énoncés RÉELS des annales de ce cours (+ des pièges déjà repérés).`,
        `Décris la TEXTURE DE DIFFICULTÉ typique — réponds UNIQUEMENT avec le JSON demandé.`,
        ``,
        ...sample.map((s, i) => `  ${i + 1}. ${(s.points ? `[${s.points} pts] ` : "")}${s.statement.replace(/\s+/g, " ").slice(0, 220)}`),
        traps.length ? `\nPièges déjà repérés : ${traps.map((t) => t.trap).join(" · ").slice(0, 800)}` : ``,
        ``,
        JSON.stringify(DIFF_SCHEMA, null, 2),
      ].join("\n");
      const parsed = extractJson<{ summary?: string; non_round_numbers?: boolean; staircase_subquestions?: boolean; typical_traps?: string[] }>(
        await completeText({ prompt, model: "opus", timeoutMs: 240_000 })
      );
      if (parsed?.summary) {
        dna.difficulty = {
          summary: parsed.summary.slice(0, 600),
          non_round_numbers: typeof parsed.non_round_numbers === "boolean" ? parsed.non_round_numbers : null,
          staircase_subquestions: typeof parsed.staircase_subquestions === "boolean" ? parsed.staircase_subquestions : null,
          typical_traps: (parsed.typical_traps ?? []).slice(0, 6).map((t) => String(t).slice(0, 200)),
        };
      }
    }
  } catch (e) {
    step(`Texture non dérivée (${(e as Error).message.slice(0, 40)}) — ADN sans texture (honnête)`, 90);
  }

  dna.detected_at = new Date().toISOString().slice(0, 19).replace("T", " ");
  await saveDna(dna);
  step(`ADN agrégé : ${dna.molds.length} moules, ${dna.figures.kinds.length} types de figures ✓`, 100);
  return dna;
}

/** Pipeline complet (ré-entrant) : classification des moules → scan figures → agrégation. */
export async function detectExamDna(opts: { onStep?: Step } = {}): Promise<ExamDna> {
  const step = opts.onStep ?? (() => {});
  await ensureDnaSchema();
  await classifyMolds((s, p) => step(s, Math.round(p * 0.45)));
  await scanFigures((s, p) => step(s, 45 + Math.round(p * 0.35)));
  return await aggregateDna((s, p) => step(s, 80 + Math.round(p * 0.2)));
}

// ---------------- P2 — échantillonnage par MOULE + couverture LARGE (purs, testés) ----------------

/**
 * Alloue n questions aux moules PROPORTIONNELLEMENT à la distribution détectée (plus fort reste),
 * puis entrelace (round-robin pondéré) pour ne pas grouper tous les moules identiques.
 * DÉTERMINISTE (aucun RNG) → testable, reproductible. dna nul/vide → [null, …] (comportement d'avant).
 */
export function sampleMolds(dna: ExamDna | null, n: number, opts: { only?: MoldKind[] } = {}): (MoldKind | null)[] {
  if (n <= 0) return [];
  const pool = (dna?.molds ?? []).filter((m) => m.count > 0 && (!opts.only || opts.only.includes(m.mold)));
  if (!pool.length) return Array(n).fill(null);
  const total = pool.reduce((s, m) => s + m.count, 0);
  // plus fort reste (Hamilton) : quotas exacts → parts entières, restes décroissants.
  const quotas = pool.map((m) => ({ mold: m.mold, exact: (m.count / total) * n }));
  const alloc = quotas.map((qt) => ({ mold: qt.mold, k: Math.floor(qt.exact), rest: qt.exact - Math.floor(qt.exact) }));
  let left = n - alloc.reduce((s, a) => s + a.k, 0);
  for (const a of [...alloc].sort((x, y) => y.rest - x.rest || x.mold.localeCompare(y.mold))) {
    if (left <= 0) break;
    a.k++; left--;
  }
  // entrelacement : à chaque pas, le moule au plus grand « dû » (k_i / total_i restant) — stable.
  const out: (MoldKind | null)[] = [];
  const remaining = alloc.filter((a) => a.k > 0).map((a) => ({ ...a, used: 0 }));
  for (let i = 0; i < n && remaining.length; i++) {
    remaining.sort((x, y) => (y.k - y.used) / y.k - (x.k - x.used) / x.k || y.k - x.k || x.mold.localeCompare(y.mold));
    const pick = remaining[0];
    out.push(pick.mold);
    pick.used++;
    if (pick.used >= pick.k) remaining.splice(0, 1);
  }
  while (out.length < n) out.push(null);
  return out;
}

/**
 * Couverture LARGE : choisit n sujets dans une liste pondérée SANS tronquer la longue traîne.
 * ~60 % des slots suivent la tête (ordre de poids), le reste échantillonne la traîne à pas
 * régulier (stride déterministe) → les sujets rares apparaissent, proportion tête préservée.
 * Corrige le « ORDER BY weight DESC LIMIT 14 » qui rendait la traîne invisible.
 */
export function pickCoverage<T>(items: T[], n: number): T[] {
  if (n <= 0 || !items.length) return [];
  if (items.length <= n) {
    // assez de slots pour TOUT couvrir → chacun au moins une fois (cyclique au-delà).
    return Array.from({ length: n }, (_, i) => items[i % items.length]);
  }
  const nHead = Math.max(1, Math.ceil(n * 0.6));
  const head = items.slice(0, nHead);
  const tail = items.slice(nHead);
  const nTail = n - nHead;
  const out = [...head];
  if (nTail > 0 && tail.length) {
    const stride = tail.length / nTail;
    for (let i = 0; i < nTail; i++) out.push(tail[Math.min(tail.length - 1, Math.floor(i * stride))]);
  }
  return out.slice(0, n);
}

// ---------------- P3 — few-shot RÉELS par moule (imitation resserrée) ----------------

/**
 * De VRAIES questions de CE cours pour un moule donné (énoncés courts extraits des annales) —
 * injectées en few-shot dans la génération : imiter le style réel, jamais copier.
 */
export async function fewShotForMold(mold: MoldKind | null, k = 2): Promise<string[]> {
  if (!mold) return [];
  try {
    await ensureDnaSchema();
    const rows = await q.all<{ statement: string | null; exam_year: number | null }>(
      `SELECT statement, exam_year FROM exam_exercises
        WHERE mold = ? AND statement IS NOT NULL ORDER BY (exam_year IS NULL), exam_year DESC, id LIMIT ?`,
      mold, k
    );
    return rows
      .filter((r) => (r.statement ?? "").trim().length > 20)
      .map((r) => `(${r.exam_year ?? "annale"}) ${(r.statement ?? "").replace(/\s+/g, " ").slice(0, 260)}`);
  } catch { return []; }
}
