import { currentCourse, sqlite } from "@/db/client";
import { extractJson, runClaudeCode } from "@/lib/claude-code";
import { getCourse } from "@/lib/courses";
import { renderExamPages } from "@/lib/exam-index";
import { getFormatProfile } from "@/lib/format";
import { profile } from "@/lib/course-profile";
import { solveFromScratch } from "@/lib/verify";
import path from "node:path";

/**
 * HARNAIS D'ÉVALUATION (interne, lecture seule). Mesure un CHIFFRE reproductible de la JUSTESSE du
 * vrai moteur : on fait RÉSOUDRE à l'aveugle (lib/verify.solveFromScratch) des questions de vrais
 * finals dont on connaît le corrigé OFFICIEL, puis on JUGE (déterministe si numérique/mcq/court,
 * LLM sinon, avec un bucket « incertain »). + discrimination (audit adversarial) + style.
 *
 * N'écrit QUE ses propres tables (`eval_items`, `eval_runs`) et des rapports dans data/refs/proof/evals.
 * Ne touche ni à la génération ni à l'UI. Jamais de faux « correct » : le doute → « uncertain ».
 */

export type StepCb = (msg: string, pct: number) => void;
export const PROMPT_VERSION = "evals-v3"; // v3 : QCM DÉTERMINISTE (options stockées, lettre vs lettre) ; LLM UNIQUEMENT pour l'ouvert

export function ensureEvalSchema() {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS eval_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_exam TEXT,
    exam_page INTEGER,
    question_text TEXT NOT NULL,
    official_answer TEXT NOT NULL,
    answer_type TEXT NOT NULL,
    points REAL,
    topic TEXT,
    options TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );`);
  // V2 — options des QCM (jugement déterministe lettre vs lettre), ajoutées au fil de l'eau.
  if (!(sqlite.prepare(`PRAGMA table_info(eval_items)`).all() as { name: string }[]).some((c) => c.name === "options"))
    sqlite.exec(`ALTER TABLE eval_items ADD COLUMN options TEXT`);
  // cache des résolutions du solveur (re-juger sans re-résoudre).
  sqlite.exec(`CREATE TABLE IF NOT EXISTS eval_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    solution TEXT,
    final_answer TEXT,
    verdict TEXT,
    reason TEXT,
    judged_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS eval_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    model TEXT,
    prompt_version TEXT,
    n_items INTEGER,
    accuracy REAL,
    uncertain_rate REAL,
    discrimination REAL,
    style_score REAL,
    notes TEXT
  );`);
}

// ─────────────────────── PHASE 1 — jeu étalon (gold set) ───────────────────────

const GOLD_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          page: { type: "integer", description: "Page (1-based) de la question." },
          question_text: { type: "string", description: "Énoncé AUTO-SUFFISANT de la question (recopié/condensé fidèlement, avec les données chiffrées nécessaires)." },
          official_answer: { type: "string", description: "La RÉPONSE OFFICIELLE exacte (pour un QCM : la/les LETTRE(S), ex. « C » ou « B, D »). Pas tout le raisonnement." },
          answer_type: { type: "string", description: "numeric = UN nombre. mcq = QCM (lettre(s) A-E) — exige options. short = réponse CANONIQUE TRÈS COURTE (≤ 6 mots) comparable mot-à-mot : une valeur, une expression (« O(n log n) »), yes/no, un nom, une suite de nombres. open = TOUT le reste (méthode/algorithme à décrire, preuve, explication) → jugé sur le raisonnement. Dans le doute entre short et open, choisis open." },
          options: { type: "string", description: "OBLIGATOIRE si answer_type=mcq : les options complètes, une par ligne, ex. « A) … \\nB) … \\nC) … ». Vide sinon." },
          points: { type: "number" },
          topic: { type: "string", description: "Sujet court (EN)." },
        },
        required: ["page", "question_text", "official_answer", "answer_type"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

type RawGold = { page?: number; question_text?: string; official_answer?: string; answer_type?: string; options?: string; points?: number; topic?: string };

/** Sources « corrigées » du cours (fichiers …with solutions / answers / corrigé). */
function solutionRefs(): { path: string; title: string; year: number | null }[] {
  const rows = sqlite.prepare(`SELECT path, title, year FROM sources WHERE type IN ('final','midterm') GROUP BY path`).all() as { path: string; title: string; year: number | null }[];
  const isSol = (s: string) => /solution|answer|corrig|grading/i.test(s);
  // un corrigé par année (le plus complet), trié récents d'abord
  const byYear = new Map<string, { path: string; title: string; year: number | null }>();
  for (const r of rows) {
    if (!isSol(r.path) && !isSol(r.title)) continue;
    const key = String(r.year ?? r.path);
    if (!byYear.has(key)) byYear.set(key, r);
  }
  return [...byYear.values()].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
}

/**
 * Construit le gold set (idempotent : purge + reconstruit). ~`max` items propres, variés, depuis les
 * corrigés (vision). Résilient : un examen illisible est ignoré.
 */
export async function buildGoldSet(opts: { max?: number; onStep?: StepCb } = {}): Promise<{ items: number; exams: number }> {
  ensureEvalSchema();
  const step = opts.onStep ?? (() => {});
  const max = opts.max ?? 30;
  const course = currentCourse();
  const refs = solutionRefs();
  if (!refs.length) { step("Aucun corrigé (with solutions) ingéré — gold set vide.", 100); return { items: 0, exams: 0 }; }
  sqlite.exec(`DELETE FROM eval_items`);
  const ins = sqlite.prepare(`INSERT INTO eval_items (source_exam, exam_page, question_text, official_answer, answer_type, points, topic, options) VALUES (?,?,?,?,?,?,?,?)`);
  const perExam = Math.max(4, Math.ceil(max / Math.min(refs.length, 8))); // ≤ ~8 examens visionnés (coût borné)
  let total = 0, examsUsed = 0;
  for (const ref of refs) {
    if (total >= max) break;
    const basename = path.basename(ref.path);
    const pages = renderExamPages(course, basename);
    if (!pages.length) { step(`${ref.title} : pages non rendues (ignoré)`, 10); continue; }
    const prompt = [
      `Voici TOUTES les pages d'un examen CORRIGÉ : « ${ref.title} »${ref.year ? ` (${ref.year})` : ""}. Ouvre-les (outil Read) ; elles contiennent les énoncés ET les solutions officielles.`,
      ...pages.map((pg) => `  - page ${pg.page} : ${pg.rel}`),
      ``,
      `Extrais jusqu'à ${perExam} paires (question, RÉPONSE OFFICIELLE) où la réponse est CLAIRE et VÉRIFIABLE (privilégie les questions à réponse numérique, à choix (A-E), ou à réponse courte type « O(n log n) », « yes/no », un invariant…). Évite les questions dont la « réponse » est une longue preuve, SAUF si tu peux résumer la conclusion attendue. Recopie/condense l'énoncé fidèlement avec ses données chiffrées (auto-suffisant), et donne la réponse officielle EXACTE du corrigé.`,
      `IMPORTANT pour les QCM (answer_type=mcq) : recopie TOUTES les options dans le champ "options" (A) …, B) …, …) et mets la/les LETTRE(S) correcte(s) dans official_answer. Varie les types et les topics.`,
      ``,
      `Réponds UNIQUEMENT avec { "items": [ … ] } :`,
      JSON.stringify(GOLD_SCHEMA, null, 2),
    ].join("\n");
    const dirs = Array.from(new Set(pages.map((pg) => path.dirname(path.resolve(pg.rel)))));
    let raw: RawGold[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const parsed = extractJson<{ items?: RawGold[] }>(await runClaudeCode({ prompt, model: "opus", timeoutMs: 600_000, addDirs: dirs }));
        raw = parsed?.items ?? [];
        if (raw.length) break;
      } catch (e) { step(`${ref.title} : extraction échouée${attempt < 2 ? " — réessai" : " — ignoré"} (${(e as Error).message.slice(0, 40)})`, 10); }
    }
    let added = 0;
    for (const g of raw) {
      if (total >= max) break;
      const q = (g.question_text ?? "").trim();
      const a = (g.official_answer ?? "").trim();
      let t = ["numeric", "short", "open", "mcq"].includes((g.answer_type ?? "").trim()) ? g.answer_type!.trim() : "open";
      const opts = (g.options ?? "").trim();
      // un « mcq » sans options stockées ne peut pas être jugé en déterministe lettre → rétrograde en short.
      if (t === "mcq" && opts.length < 4) t = /^[A-E](\s*,\s*[A-E])*$/i.test(a) ? "mcq" : "short";
      if (q.length < 12 || a.length < 1) continue;
      ins.run(ref.title, Math.max(1, Math.round(Number(g.page) || 1)), q.slice(0, 2000), a.slice(0, 500), t, Number(g.points) > 0 ? Number(g.points) : null, (g.topic ?? "").slice(0, 120) || null, opts.slice(0, 1500) || null);
      total++; added++;
    }
    if (added) examsUsed++;
    step(`${ref.title} : ${added} item(s) — gold set ${total}/${max}`, 10 + Math.round((total / max) * 80));
  }
  step(`Gold set : ${total} items sur ${examsUsed} examens`, 100);
  return { items: total, exams: examsUsed };
}

// ─────────────────────── PHASE 2 — justesse du solveur ───────────────────────

export type EvalItem = { id: number; sourceExam: string; examPage: number | null; questionText: string; officialAnswer: string; answerType: string; topic: string | null; options: string | null };
export type Judged = { id: number; topic: string | null; answerType: string; official: string; cortex: string; verdict: "correct" | "incorrect" | "uncertain"; reason: string; sourceExam?: string; examPage?: number | null };

function goldItems(limit?: number): EvalItem[] {
  ensureEvalSchema();
  const rows = sqlite.prepare(`SELECT id, source_exam sourceExam, exam_page examPage, question_text questionText, official_answer officialAnswer, answer_type answerType, topic, options FROM eval_items ORDER BY id${limit ? " LIMIT " + Math.max(1, Math.floor(limit)) : ""}`).all() as any[];
  return rows.map((r) => ({ ...r }));
}

/** Énoncé augmenté passé au solveur : QCM → on lui DONNE les options et on exige une LETTRE. */
function solvePrompt(it: EvalItem): string {
  const parts = [it.questionText];
  if (it.answerType === "mcq" && it.options) {
    parts.push(`\nOPTIONS :\n${it.options}`);
    parts.push(`\nC'est un QCM : donne UNIQUEMENT la/les LETTRE(S) de la/des bonne(s) réponse(s) sur la ligne « RÉPONSE : … ».`);
  } else {
    parts.push(`\n(Réponds dans la LANGUE de l'énoncé ; « RÉPONSE : » = ton résultat final concis.)`);
  }
  return parts.join("\n");
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9αβγθλ().+\-*/^ ]+/gi, " ").replace(/\s+/g, " ").trim();
const numbersIn = (s: string) => (s.match(/-?\d+(?:[.,]\d+)?/g) ?? []).map((x) => parseFloat(x.replace(",", ".")));
// MCQ : seulement les lettres-CHOIX A-E EN MAJUSCULE et isolées (pas les variables math « a=9, b=3 »).
const lettersIn = (s: string) => Array.from(new Set((s.match(/\b[A-E]\b/g) ?? []))).sort();
/** Lettre(s) de réponse en TÊTE de réponse (« C », « B, D ») — ignore les lettres dans l'explication. */
function mcqLetters(s: string): string[] {
  const head = s.trim().match(/^[\s(]*([A-E](?:\s*(?:[,&]|and|et|ou|or)\s*[A-E])*)/i);
  if (head) return Array.from(new Set(head[1].toUpperCase().match(/[A-E]/g) ?? [])).sort();
  // sinon : une seule lettre isolée dans toute la réponse (sinon ambigu → vide)
  const all = Array.from(new Set(s.match(/\b[A-E]\b/g) ?? [])).sort();
  return all.length === 1 ? all : [];
}
// suite de nombres « 2, 4, 1, … » (réponses Prim/parcours) → comparaison de séquence normalisée.
const numSeq = (s: string) => (s.match(/-?\d+/g) ?? []).join(",");
/** Dernière « RÉPONSE : … » de la solution, sinon les ~200 derniers caractères. */
function finalAnswer(sol: string): string {
  const m = [...sol.matchAll(/r[ée]ponse\s*[:=]\s*(.+)/gi)];
  if (m.length) return m[m.length - 1][1].trim();
  return sol.slice(-220).trim();
}

/** Juge DÉTERMINISTE (numeric/mcq/short). Biais vers « uncertain » plutôt qu'un faux verdict. */
function judgeDeterministic(item: EvalItem, cortexAns: string): { verdict: Judged["verdict"]; reason: string } {
  const off = item.officialAnswer;
  if (item.answerType === "numeric") {
    const no = numbersIn(off), nc = numbersIn(cortexAns);
    if (!no.length) return { verdict: "uncertain", reason: "réponse officielle non numérique" };
    if (!nc.length) return { verdict: "uncertain", reason: "pas de nombre dans la réponse du solveur" };
    const hit = no.every((x) => nc.some((y) => Math.abs(x - y) <= Math.max(1e-6, Math.abs(x) * 1e-3)));
    return hit ? { verdict: "correct", reason: "nombres concordants" } : { verdict: "incorrect", reason: `attendu ${no.join(",")} · obtenu ${nc.join(",") || "—"}` };
  }
  if (item.answerType === "mcq") {
    const lo = lettersIn(off), lc = mcqLetters(cortexAns);
    if (!lo.length) return { verdict: "uncertain", reason: "pas de lettre dans la réponse officielle" };
    if (!lc.length) return { verdict: "uncertain", reason: "pas de lettre claire dans la réponse du solveur" };
    return JSON.stringify(lo) === JSON.stringify(lc) ? { verdict: "correct", reason: lo.join("") } : { verdict: "incorrect", reason: `attendu ${lo.join("")} · obtenu ${lc.join("")}` };
  }
  // short : si la réponse officielle est une SUITE DE NOMBRES (Prim, parcours…), compare la séquence.
  const seqO = numSeq(off);
  if (seqO && (off.match(/\d/g) ?? []).length >= 3 && /^[\d,\s]+$/.test(off.replace(/[.\-]/g, ""))) {
    const seqC = numSeq(cortexAns);
    if (!seqC) return { verdict: "uncertain", reason: "pas de séquence dans la réponse du solveur" };
    return seqO === seqC ? { verdict: "correct", reason: "séquence exacte" } : { verdict: "incorrect", reason: `attendu ${seqO} · obtenu ${seqC}` };
  }
  // sinon : recouvrement de tokens (mots ≥2 ET nombres). Recouvrement partiel → uncertain (pas faux).
  const offTokens = norm(off).split(" ").filter((w) => w.length >= 2 || /^\d+$/.test(w));
  if (!offTokens.length) return { verdict: "uncertain", reason: "réponse officielle vide après normalisation" };
  const cn = norm(cortexAns);
  if (!cn) return { verdict: "uncertain", reason: "réponse du solveur vide" };
  const present = offTokens.filter((w) => cn.includes(w)).length / offTokens.length;
  if (present >= 0.8) return { verdict: "correct", reason: `tokens présents ${Math.round(present * 100)}%` };
  return { verdict: "uncertain", reason: `recouvrement ${Math.round(present * 100)}% → arbitrage` };
}

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", description: "correct | incorrect | uncertain (uncertain si tu n'es pas sûr — ne devine pas)." },
    reason: { type: "string", description: "Une phrase : pourquoi." },
  },
  required: ["verdict", "reason"],
  additionalProperties: false,
} as const;

/** Juge LLM (questions ouvertes) : compare la solution du solveur au corrigé officiel. */
async function judgeOpen(item: EvalItem, cortexFull: string): Promise<{ verdict: Judged["verdict"]; reason: string }> {
  const prompt = [
    `Tu es un correcteur impartial. Compare la RÉPONSE D'UN ÉTUDIANT au CORRIGÉ OFFICIEL d'une question d'examen, et dis si l'étudiant a JUSTE.`,
    ``,
    `QUESTION :\n${item.questionText}`,
    ``,
    `CORRIGÉ OFFICIEL (vérité terrain) :\n${item.officialAnswer}`,
    ``,
    `RÉPONSE DE L'ÉTUDIANT :\n${cortexFull.slice(0, 4000)}`,
    ``,
    `verdict = "correct" si l'étudiant arrive à la même conclusion/résultat correct (même par un chemin différent) ; "incorrect" si la conclusion est fausse/contradictoire ; "uncertain" si tu ne peux pas trancher honnêtement. Ne donne JAMAIS "correct" par défaut.`,
    `Réponds UNIQUEMENT avec l'objet JSON :`,
    JSON.stringify(JUDGE_SCHEMA, null, 2),
  ].join("\n");
  try {
    const r = extractJson<{ verdict: string; reason: string }>(await runClaudeCode({ prompt, model: "opus", timeoutMs: 240_000 }));
    const v = ["correct", "incorrect", "uncertain"].includes(r.verdict) ? (r.verdict as Judged["verdict"]) : "uncertain";
    return { verdict: v, reason: (r.reason ?? "").slice(0, 200) };
  } catch {
    return { verdict: "uncertain", reason: "juge LLM indisponible" };
  }
}

export type AccuracyResult = { n: number; correct: number; incorrect: number; uncertain: number; accuracy: number; uncertainRate: number; details: Judged[] };

/** Résout chaque item à l'aveugle (vrai moteur) puis juge → accuracy + uncertain. Résilient (3 en //). */
export async function runAccuracy(opts: { limit?: number; onStep?: StepCb } = {}): Promise<AccuracyResult> {
  ensureEvalSchema();
  const step = opts.onStep ?? (() => {});
  const items = goldItems(opts.limit);
  if (!items.length) throw new Error("Gold set vide : construis-le d'abord (buildGoldSet).");
  const cache = sqlite.prepare(`INSERT INTO eval_attempts (item_id, solution, final_answer, verdict, reason, judged_by) VALUES (?,?,?,?,?,?)`);
  let done = 0;
  const details: Judged[] = new Array(items.length);
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx++;
      const it = items[i];
      let verdict: Judged["verdict"] = "uncertain", reason = "non résolu", cortex = "", judgedBy = "—", sol = "";
      try {
        sol = (await solveFromScratch(solvePrompt(it))) ?? "";
        if (sol) {
          cortex = finalAnswer(sol);
          // V3 — DÉTERMINISTE pour numeric/mcq/short (zéro complaisance LLM) ; LLM UNIQUEMENT pour l'ouvert.
          if (it.answerType === "open") { const j = await judgeOpen(it, sol); verdict = j.verdict; reason = j.reason; judgedBy = "llm-open"; }
          else { const det = judgeDeterministic(it, cortex); verdict = det.verdict; reason = det.reason; judgedBy = "deterministic"; }
        }
      } catch (e) { reason = `item ignoré (${(e as Error).message.slice(0, 40)})`; }
      try { cache.run(it.id, sol.slice(0, 8000), cortex.slice(0, 500), verdict, reason.slice(0, 300), judgedBy); } catch {}
      details[i] = { id: it.id, topic: it.topic, answerType: it.answerType, official: it.officialAnswer, cortex, verdict, reason, sourceExam: it.sourceExam, examPage: it.examPage };
      done++;
      step(`Justesse ${done}/${items.length} — ${it.topic ?? it.answerType} : ${verdict}`, Math.round((done / items.length) * 100));
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, worker));
  const correct = details.filter((d) => d.verdict === "correct").length;
  const incorrect = details.filter((d) => d.verdict === "incorrect").length;
  const uncertain = details.filter((d) => d.verdict === "uncertain").length;
  const decided = correct + incorrect;
  return {
    n: items.length, correct, incorrect, uncertain,
    accuracy: decided ? Math.round((correct / decided) * 1000) / 10 : 0,
    uncertainRate: items.length ? Math.round((uncertain / items.length) * 1000) / 10 : 0,
    details,
  };
}

// ─────────────────────── PHASE 3 — discrimination + style ───────────────────────

/** Génère `n` exos via l'architecte et mesure le % où le pattern-matcher ÉCHOUE (discrimination). */
export async function measureDiscrimination(opts: { n?: number; onStep?: StepCb } = {}): Promise<{ n: number; discriminating: number; discrimination: number }> {
  const step = opts.onStep ?? (() => {});
  const n = Math.max(1, opts.n ?? 2);
  const { architectQuestion } = await import("@/lib/architect");
  const archs = profile().archetypes;
  if (!archs.length) return { n: 0, discriminating: 0, discrimination: 0 };
  let discriminating = 0, made = 0;
  for (let i = 0; i < n; i++) {
    const a = archs[i % archs.length];
    step(`Discrimination ${i + 1}/${n} — génération « ${a.id} »…`, Math.round((i / n) * 100));
    try {
      const r = await architectQuestion(a, a.concept, 15, { maxRounds: 1 });
      const last = r.auditLog?.[r.auditLog.length - 1] as { pattern_matcher_correct?: boolean } | undefined;
      if (last && last.pattern_matcher_correct === false) discriminating++;
      made++;
    } catch (e) { step(`Discrimination ${i + 1} ignorée (${(e as Error).message.slice(0, 40)})`, 0); }
  }
  return { n: made, discriminating, discrimination: made ? Math.round((discriminating / made) * 1000) / 10 : 0 };
}

/** Style/format : score simple de ressemblance d'un exo généré au format détecté (v1 : heuristique bornée). */
export function measureStyleHeuristic(): { styleScore: number; note: string } {
  const fmt = getFormatProfile();
  if (!fmt) return { styleScore: 0, note: "pas de format_profile" };
  // v1 : on crédite la présence d'un format détecté riche (types + convention) — proxy honnête, borné.
  const hasTypes = (fmt.question_types ?? []).length >= 2;
  const hasConvention = !!fmt.scq_vs_mcq_convention;
  const score = (hasTypes ? 60 : 30) + (hasConvention ? 25 : 0) + (fmt.total_points ? 15 : 0);
  return { styleScore: Math.min(100, score), note: `${(fmt.question_types ?? []).length} types détectés${hasConvention ? ", convention SCQ/MCQ lue" : ""}` };
}

// ─────────────────────── PHASE 4 — run + rapport ───────────────────────

export function recordRun(r: { accuracy: number; uncertainRate: number; nItems: number; discrimination: number | null; styleScore: number | null; notes: string }): number {
  ensureEvalSchema();
  return sqlite.prepare(
    `INSERT INTO eval_runs (course, model, prompt_version, n_items, accuracy, uncertain_rate, discrimination, style_score, notes) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(currentCourse(), "opus", PROMPT_VERSION, r.nItems, r.accuracy, r.uncertainRate, r.discrimination, r.styleScore, r.notes).lastInsertRowid as number;
}

export function buildReport(acc: AccuracyResult, disc: { n: number; discrimination: number } | null, style: { styleScore: number; note: string } | null): string {
  const c = getCourse(currentCourse());
  const lines: string[] = [];
  lines.push(`# Eval — ${c.examCode} ${c.examName} — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`);
  lines.push(``);
  lines.push(`Solveur à l'aveugle (lib/verify.solveFromScratch) vs corrigés officiels · prompt ${PROMPT_VERSION}.`);
  lines.push(``);
  lines.push(`## Justesse (métrique #1)`);
  lines.push(`- **accuracy = ${acc.accuracy}%** (sur ${acc.correct + acc.incorrect} items tranchés : ${acc.correct} justes / ${acc.incorrect} faux)`);
  lines.push(`- incertain = ${acc.uncertainRate}% (${acc.uncertain}/${acc.n}) — non comptés dans l'accuracy`);
  if (disc) lines.push(`- discrimination = ${disc.discrimination}% (pattern-matcher échoue sur ${disc.n} exos générés)`);
  if (style) lines.push(`- style/format = ${style.styleScore}/100 (${style.note})`);
  lines.push(``);
  lines.push(`## Détail par item`);
  for (const d of acc.details) {
    const mark = d.verdict === "correct" ? "✓" : d.verdict === "incorrect" ? "✗" : "?";
    lines.push(`- ${mark} [${d.answerType}] ${d.topic ?? ""} — attendu « ${(d.official || "").slice(0, 60)} » · obtenu « ${(d.cortex || "—").slice(0, 60)} » (${d.reason})`);
  }
  const review = acc.details.filter((d) => d.verdict === "uncertain" || d.verdict === "incorrect");
  if (review.length) {
    lines.push(``);
    lines.push(`## À revoir à la main (incertains + faux) — ${review.length}`);
    for (const d of review) lines.push(`- [${d.verdict}/${d.answerType}] ${d.topic ?? ""} (${d.sourceExam ?? "?"}${d.examPage ? ` p.${d.examPage}` : ""}) : attendu « ${(d.official || "").slice(0, 80)} » · obtenu « ${(d.cortex || "—").slice(0, 80) }» — ${d.reason}`);
  }
  return lines.join("\n");
}
