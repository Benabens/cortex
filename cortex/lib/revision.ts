import { currentCourse, sqlite } from "@/db/client";
import { completeText, extractJson } from "@/lib/llm";
import { coursePaths } from "@/lib/courses";
import { sourceHref } from "@/lib/deeplink";
import { renderExamPages } from "@/lib/exam-index";
import { generateQcmBatch, verifyQcmBatch } from "@/lib/qcm";
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
        const parsed = extractJson<{ questions?: RawQ[] }>(await completeText({ prompt, model: "opus", timeoutMs: 600_000, addDirs: dirs }));
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
  try { ranks = extractJson<{ ranks?: { topic: string; lecture_rank?: number }[] }>(await completeText({ prompt, model: "opus", timeoutMs: 180_000 }))?.ranks ?? []; } catch {}
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

// ─────────────────────── P3 — parcours généré (couverture 100 % à la bonne proportion) ───────────────────────

const LETTERS = ["A", "B", "C", "D", "E", "F"];

/**
 * Génère un PARCOURS de questions NEUVES couvrant TOUT le programme (chaque sujet ≥ 1 QCM) à la
 * proportion réelle des finals (sujet fréquent → plus de questions). Réutilise l'architecte QCM
 * (distracteurs = idées fausses, vérif à l'aveugle) + l'architecte ouvert. Persiste dans revision_plan.
 */
export async function buildParcours(opts: { budgetQcm?: number; budgetOpen?: number; onStep?: StepCb } = {}): Promise<{ qcm: number; open: number; topics: number }> {
  ensureRevisionSchema();
  const step = opts.onStep ?? (() => {});
  const stats = bankStats();
  if (!stats.byTopic.length) throw new Error("Banque vide : construis-la d'abord (indexBank).");
  const budgetQcm = opts.budgetQcm ?? 24, budgetOpen = opts.budgetOpen ?? 8;
  sqlite.exec(`DELETE FROM revision_plan`);

  // « TOPIC DU PROGRAMME » = niveau LECTURE : on consolide les sous-variantes (k-NN / k-NN classif / …)
  // par lecture_rank → ~14 sujets (le programme), représentant = le sous-sujet le plus présent. Évite
  // d'exploser le budget (60 sous-variantes) tout en garantissant la couverture de CHAQUE lecture.
  const byRank = new Map<number, { topic: string, repCount: number, qcm: number, open: number, rank: number }>();
  for (const t of stats.byTopic) {
    const r = t.lectureRank ?? 99;
    const c = byRank.get(r);
    if (!c) byRank.set(r, { topic: t.topic, repCount: t.qcm + t.open, qcm: t.qcm, open: t.open, rank: r });
    else { c.qcm += t.qcm; c.open += t.open; if (t.qcm + t.open > c.repCount) { c.repCount = t.qcm + t.open; c.topic = t.topic; } }
  }
  const program = [...byRank.values()].sort((a, b) => a.rank - b.rank);
  const rank = new Map<string, number | null>(program.map((t) => [t.topic, t.rank === 99 ? null : t.rank]));
  const totalQcm = program.reduce((s, t) => s + t.qcm, 0) || 1;
  const totalOpen = program.reduce((s, t) => s + t.open, 0) || 1;

  // cibles QCM par sujet de programme : pondérées par la fréquence réelle, MIN 1 (→ couverture 100 %).
  const qcmTarget = program.map((t) => ({ topic: t.topic, n: Math.max(1, Math.round((t.qcm / totalQcm) * budgetQcm)) }));
  // liste pondérée (chaque sujet répété n fois) → lots de 6 (1 QCM par entrée, pas de focus = couverture).
  const weighted: string[] = [];
  for (const t of qcmTarget) for (let k = 0; k < t.n; k++) weighted.push(t.topic);

  const insQ = sqlite.prepare(`INSERT INTO revision_plan (kind, topic, lecture_rank, statement, options, correct, misconceptions, explanation, verified, verify_method) VALUES ('qcm',?,?,?,?,?,?,?,?,?)`);
  let nq = 0;
  const BATCH = 6;
  for (let b = 0; b < weighted.length; b += BATCH) {
    const chunk = weighted.slice(b, b + BATCH);
    const prog = 5 + Math.round((b / weighted.length) * 55);
    step(`Parcours QCM — lot ${Math.floor(b / BATCH) + 1} (${chunk.join(", ").slice(0, 50)}…)`, prog);
    try {
      const topicsArg = chunk.map((t) => ({ label: t, method: null }));
      let items = await generateQcmBatch(topicsArg, chunk.length, () => {});
      try { items = await verifyQcmBatch(items, () => {}); } catch {}
      items.slice(0, chunk.length).forEach((it, j) => {
        const tp = chunk[j] ?? it.topic;
        const opts = (it.options ?? []).map((o, k) => `${LETTERS[k]}) ${o}`).join("\n");
        const correct = (it.correct ?? []).map((c) => LETTERS[c] ?? "?").join(", ");
        insQ.run(tp, rank.get(tp) ?? null, it.stem, opts, correct, JSON.stringify(it.misconceptions ?? []), it.explanation ?? null, it.verified ?? null, it.verified === 1 ? "qcm-blind-verify" : null);
        nq++;
      });
    } catch (e) { step(`Lot QCM ignoré (${(e as Error).message.slice(0, 40)})`, prog); }
  }

  // OUVERTES : réparties sur les sujets de programme les plus lourds (proportion open au final).
  const openTarget = program
    .map((t) => ({ topic: t.topic, w: (t.open / totalOpen) + (t.qcm / totalQcm) * 0.3 }))
    .sort((a, b) => b.w - a.w).slice(0, budgetOpen);
  const { architectQuestion } = await import("@/lib/architect");
  const { profile } = await import("@/lib/course-profile");
  const archs = profile().archetypes as any[];
  const insO = sqlite.prepare(`INSERT INTO revision_plan (kind, topic, lecture_rank, statement, solution, verified, verify_method) VALUES ('open',?,?,?,?,?,?)`);
  let no = 0;
  for (let i = 0; i < openTarget.length; i++) {
    const tp = openTarget[i].topic;
    step(`Parcours ouvertes — ${tp} (${i + 1}/${openTarget.length})`, 62 + Math.round((i / Math.max(1, openTarget.length)) * 35));
    try {
      const a = archs[i % archs.length];
      const r = await architectQuestion(a, tp, 15, { maxRounds: 1 });
      insO.run(tp, rank.get(tp) ?? null, r.q.statement_tex, r.q.solution_tex, 1, "architect");
      no++;
    } catch (e) { step(`Ouverte ${tp} ignorée (${(e as Error).message.slice(0, 40)})`, 70); }
  }
  step(`Parcours : ${nq} QCM + ${no} ouvertes couvrant ${program.length} sujets de programme`, 100);
  return { qcm: nq, open: no, topics: program.length };
}

// ─────────────────────── P3+ — EXTENSION massive du parcours (≥10 QCM/topic, ciblé faiblesses) ───────────────────────

/**
 * TAXONOMIE DE TOPICS au grain « THÈME » (≈25), dans l'ordre du cours du prof (cf. carte du cours
 * de Ben). Chaque thème : un `target` de QCM (sur-pondéré sur ses thèmes faibles), des `aliases`
 * (labels existants à recompter dans ce thème → on ÉTEND, pas de doublon) et `weak` = ses erreurs
 * RÉELLES sur ce thème (servent à bâtir les distracteurs). Source faiblesses :
 * data/ml/faiblesses/CS233-faiblesses-COMPLET.md (ingéré ici sous forme de consignes de génération).
 */
export type Theme = { label: string; rank: number; target: number; aliases: string[]; weak: string | null };

export const REVISION_THEMES: Theme[] = [
  { label: "Data preprocessing", rank: 1, target: 12, aliases: ["Data requirements", "Supervised learning", "Unsupervised learning"],
    weak: "Scaler = mettre les features sur des échelles comparables (sinon une feature domine par ses unités : distances/gradients/variance). « Normalize ALL » est FAUX (pas les binaires/one-hot). Tout APRÈS le split (fit sur train) sinon data leakage. Ne PAS scaler : arbres, lin reg non-régularisée en forme fermée, one-hot. min-max sensible aux outliers ; z-score plus robuste." },
  { label: "Feature encoding", rank: 1, target: 10, aliases: [],
    weak: "Numérique → normaliser/standardiser. Catégoriel → encoder. Non-ordonné → one-hot (pas de faux ordre) ; ordonné → entier ordinal (garde l'ordre)." },
  { label: "Linear regression", rank: 2, target: 12, aliases: ["Linear regression / MLP", "Multi-output regression"],
    weak: "w* = (XᵀX)⁻¹Xᵀy (équations normales). Convexe ET forme fermée. Sort des floats (valeurs réelles continues). 1 modèle à C sorties = C modèles séparés ICI (équivalent), contrairement au MLP. Corrélation parfaite → XᵀX singulière → pas de forme close → ridge (+λI) ou PCA." },
  { label: "Outliers & robust losses", rank: 2, target: 12, aliases: [],
    weak: "Moindres carrés / MSE / moyenne = SENSIBLES aux outliers (le carré amplifie, un point extrême drague la droite). MAE / médiane = ROBUSTES. (Erreur classique : croire la médiane plus sensible — c'est l'inverse.)" },
  { label: "Loss functions & task", rank: 3, target: 14, aliases: ["Loss functions", "Cross-entropy loss"],
    weak: "La loss suit la TÂCHE, pas le mot. « Regress the probability » d'un événement binaire = CLASSIFICATION → cross-entropy (PAS square loss). Régression = valeur continue réelle → square (MSE). square + sigmoïde = mauvais (non-convexe + vanishing gradient) ; BCE + sigmoïde = gradient propre (ŷ−y)x." },
  { label: "Logistic regression", rank: 3, target: 18, aliases: ["Linear classification", "Linear classification (Fisher-style)"],
    weak: "σ n'atteint JAMAIS exactement 0/1 (asymptotique) → la cross-entropy n'est jamais exactement 0 même si séparable ; « classifieur parfait » ⟹ points LOIN de la frontière ; sur données séparables non régularisées les poids DIVERGENT (a→∞) → régulariser (L2). BCE = 2 termes −Σ[y ln ŷ + (1−y) ln(1−ŷ)] (n'oublie pas (1−y)ln(1−ŷ)). Frontière wᵀx+b=0 seulement au seuil 0.5 ; seuil τ → wᵀx+b = logit(τ) (seul l'offset bouge, ça reste un hyperplan). Multiplier (a,b) par K>0 : accuracy inchangée (signe de z), loss diminue (magnitude). accuracy = signe de z ; loss = magnitude de z." },
  { label: "Evaluation metrics", rank: 4, target: 14, aliases: ["Model evaluation", "Model selection", "Generalization"],
    weak: "Matrice de confusion = n×n (multi-classe) ; le 2×2 TP/FP/FN/TN = cas binaire. ROC = TP rate vs FP rate en VARIANT le seuil τ ; AUC = aire (1 parfait, 0.5 hasard) = P(positif scoré > négatif). 1 matrice = 1 seuil = 1 point → AUC PAS calculable d'une seule matrice. precision TP/(TP+FP), recall TP/(TP+FN), F1 = moyenne harmonique. val pire que test → chercher ce qui touche SPÉCIFIQUEMENT un set (hyperparams réglés sur test, préproc, distributions ≠), pas « pas convergé »." },
  { label: "SVM", rank: 4, target: 16, aliases: ["SVM (hard-margin)", "SVM (soft-margin)", "Max-margin"],
    weak: "SVM sort s(x)=wᵀx+b → on prend le SIGNE (pas de proba ; la proba/sigmoïde = logistic). w ⟂ frontière, longueur = demi-marge ; demi-bande = 1/‖w‖, bande = 2/‖w‖ ; maximiser la marge ⇔ minimiser ‖w‖. soft-margin = min ½‖w‖² + hinge ; slack ξ = max(0,1−y·score) = la hinge loss ; tous les SV ne sont PAS sur la marge (ξ>0). C = compromis marge↔erreurs ; grand C → overfit, marge↓ ; accuracy test fait un U (C optimal intermédiaire). SVM = QP (objectif quadratique ½‖w‖² + contraintes linéaires) ; « linear program with quadratic constraints » = FAUX (l'inverse)." },
  { label: "k-Nearest Neighbors", rank: 5, target: 10, aliases: ["k-NN", "K-Nearest Neighbors", "k-NN classification", "Classification"],
    weak: "lazy (training = stocker) · non-paramétrique · k = hyperparamètre (CV, pas gradient descent). petit k = complexe / sensible aux outliers ; grand k = lisse / stable / simple. Souffre du curse of dimensionality (distances se concentrent). La distance compte ; sert aussi à la régression (moyenne des voisins). Scaler avant (sinon la feature au plus grand range écrase la distance)." },
  { label: "Regularization & ridge", rank: 6, target: 14, aliases: ["Ridge regression", "Regularization", "Overfitting", "Generalization / overfitting", "Generalization / regularization"],
    weak: "ridge = (XᵀX+λI)⁻¹Xᵀy = LECTURE 6, PAS le cours de lin reg (L2). Remèdes overfit : régularisation (L2), dropout, early stopping, data augmentation, + de données, réduire la capacité (JAMAIS « moins de data » ni « + de features »). Variance concentrée → lack of diversity : début ok mais la CONCLUSION « overfitting » est fausse (vérifier TOUTE la chaîne)." },
  { label: "Model selection & cross-validation", rank: 6, target: 10, aliases: [],
    weak: "CV pour choisir les hyperparams (k, λ, C) sans toucher au test. Régler les hyperparams SUR le test = fuite → test trop optimiste. val pire que test = ce qui touche spécifiquement la val." },
  { label: "Convexity & closed-form", rank: 6, target: 10, aliases: [],
    weak: "Deux axes SÉPARÉS. closed-form ⟺ ∇L=0 résoluble algébriquement (≠ convexité). lin reg : convexe + fermée · logistic : convexe MAIS pas fermée · PCA : non-convexe MAIS fermée (eigendécomposition) · MLP/k-means : non-convexe + pas fermée (minima locaux, dépend de l'init)." },
  { label: "Kernels", rank: 7, target: 16, aliases: ["Kernel ridge regression", "Kernel methods", "Kernels (SVM)", "Kernels (kernel trick)", "Kernel SVM", "Feature expansion", "Feature expansion & kernels"],
    weak: "Un kernel développé = ses features cachées. Poly degré-2 CONTIENT les carrés x₀²,x₁² (→ peut faire un cercle) ; le linéaire αxᵀx'+γ reste linéaire (droite). Frontière radiale ‖x‖>1 → kernel sur le rayon ‖x‖ (devient 1D) ou RBF/poly ; le linéaire sur x brut ÉCHOUE. RBF = φ de dimension INFINIE. Sous ridge le scaling des features COMPTE → le biais c de (xᵀx'+c)ᵈ re-pondère les degrés → change w. K = O(N²D). Le kernel trick NE se transfère PAS à K-means (préfère normaliser/changer de repère)." },
  { label: "Data representations", rank: 8, target: 10, aliases: ["Bag-of-Words"],
    weak: "Representation learning : le NN apprend ses features ; avec un kernel TU choisis φ à la main. Bag-of-Words = représentation de texte." },
  { label: "MLP & backpropagation", rank: 9, target: 14, aliases: ["MLP", "Multilayer perceptron", "Neural networks", "Activation functions", "MLP optimization", "Linear regression / MLP"],
    weak: "Couche m→n : n(m+1) params (m·n poids + n biais). Ex. 784→128→10 = 128·785 + 10·129 = 101 770. Parallélisables (matrices sur GPU + batch) ; le séquentiel = RNN dans le temps. Pas de forme fermée (activations non-linéaires) + non-convexe (GD sans garantie globale). 1 modèle à C sorties ≠ C modèles (partage les couches cachées). Plus de couches → relations PLUS complexes. Symétrie de permutation : échanger 2 neurones (poids entrants ET sortants) → même fonction → M! solutions → init aléatoire pour briser la symétrie." },
  { label: "Gradient descent & optimization", rank: 9, target: 12, aliases: ["Gradient descent", "Optimization", "SGD"],
    weak: "GD = méthode générale pour minimiser une loss SANS forme fermée. Utilisée : logistic, SVM, MLP (backprop). Optionnelle : lin reg/ridge (forme fermée existe). PAS : kNN, k-means, PCA. GD complet coûteux → SGD/mini-batch (moins cher par pas, le bruit aide). Momentum : accumule une vitesse → accélère le long du fond, amortit les zigzags (vallée étroite)." },
  { label: "CNN", rank: 10, target: 12, aliases: ["CNNs", "CNN / transfer learning", "CNN training / underfitting", "Deep architectures", "Deep learning frameworks", "Class imbalance"],
    weak: "Pipeline image → [Conv+ReLU] → [Pool] → … → Flatten → FC : le POOLING vient APRÈS le conv (conv détecte, pool résume). Conv garde H×W (padding same, stride 1), change les canaux (= nb de filtres) ; Pool 2×2/stride 2 → ÷2 H et W. Spatial ↓, canaux ↑. Stride = de combien le filtre saute (≠ taille du kernel ≠ canaux). Params conv = (k×k×canaux_in)×N + N ; FC = entrée×sortie + sortie. Image plus grande, accommoder + améliorer → AJOUTER des couches (capacité + downsample), pas juste augmenter le stride." },
  { label: "Data augmentation", rank: 10, target: 10, aliases: [],
    weak: "La transfo doit PRÉSERVER le label ET rester DANS la distribution (flip horizontal d'un vêtement ✓ ; upside-down ✗). N'aide PAS le distribution shift. Régularise (réduit l'overfit)." },
  { label: "PCA", rank: 11, target: 16, aliases: ["PCA vs LDA"],
    weak: "PC = eigenvectors de la COVARIANCE (PAS de la matrice des données). PCA = autoencodeur linéaire ; minimise la reconstruction = MAXIMISE la variance ; la plus grande PC = variance MAX. Non-supervisée (corriger y → PCA inchangée) ; pas discriminante (≠ LDA). Sensible à l'échelle → normaliser avant. Objectif max wᵀΣw, ‖w‖=1 = non-convexe MAIS forme fermée. « 98% de variance → 2 PC suffisent = reconstruire l'essentiel = jeter le reste » : reformulations de la MÊME idée → même verdict." },
  { label: "Autoencoders", rank: 11, target: 10, aliases: [],
    weak: "Encodeur : entrée → code latent z ; décodeur : z → reconstruction (« reconstruire » = DÉCODEUR, pas encodeur). Denoising AE : bruit sur l'ENTRÉE, cible = version propre → empêche la copie triviale → apprend la vraie structure. Deux sens d'« encoder-decoder » : autoencodeur (x→z→x̂) vs seq2seq/transformer (cross-attention)." },
  { label: "LDA", rank: 11, target: 10, aliases: [],
    weak: "LDA = réduction de dimension SUPERVISÉE (utilise y). Mnémo : LDA = Labels. ≠ spectral clustering (non-supervisé, graphe de similarité). ≠ PCA (non-supervisée). Range par 2 critères : supervisé vs non + clustering vs réduction → LDA = réduction (avec PCA)." },
  { label: "K-means", rank: 12, target: 16, aliases: ["K-means clustering"],
    weak: "Convergence = partition de Voronoï (point → centroïde le + proche) ET centroïde = moyenne de son cluster. Optimise les distances aux centroïdes (cellules CONVEXES), pas les « paquets visuels ». Minimise l'inertie = variance intra (variance = somme des distances² à la moyenne). Optimum LOCAL (sensible à l'init). Non-supervisé (choisir K = hyperparamètre, aucun label). Échoue sur centre+anneau (concentrique, non-convexe) → polaire (rayon) ou spectral. Variante médiane = plus robuste aux outliers (assignations dures)." },
  { label: "Spectral clustering & GMM/EM", rank: 12, target: 10, aliases: ["Spectral clustering"],
    weak: "Spectral clustering = non-supervisé, graphe de similarité → sépare le non-convexe (anneaux concentriques) là où K-means échoue. ≠ LDA (supervisée). GMM/EM = clusters mous (probabilités d'appartenance) vs K-means dur." },
  { label: "RNN & sequence models", rank: 13, target: 10, aliases: [],
    weak: "RNN = séquentiel : hₜ dépend de hₜ₋₁ → NON parallélisable (tout le reste l'est). Le « séquentiel dans le temps » (RNN) ≠ « parallèle dans la couche/batch » (MLP/CNN)." },
  { label: "Self-attention & Transformers", rank: 13, target: 10, aliases: ["Attention", "Transformer", "Self-attention"],
    weak: "Self-attention = chaque token regarde tous les autres (parallélisable, contrairement au RNN). Transformer = encoder-decoder à attention (cross-attention) ≠ autoencodeur (x→z→x̂). MLP/CNN/RNN/Transformer = des TYPES de NN." },
];

const normStem = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const tokens = (s: string) => new Set(normStem(s).split(" ").filter((w) => w.length > 3));
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Labels (canonique + alias) d'un thème, pour recompter l'existant et éviter les doublons. */
function themeLabels(t: Theme): string[] { return [t.label, ...t.aliases]; }

/** Tous les énoncés déjà couverts pertinents pour un thème (banque + parcours) → anti-doublon. */
function coveredStemsForTheme(t: Theme): string[] {
  const labels = themeLabels(t).map((l) => l.toLowerCase());
  const ph = labels.map(() => "?").join(",");
  const bank = sqlite.prepare(`SELECT statement FROM bank_questions WHERE lower(topic) IN (${ph})`).all(...labels) as { statement: string }[];
  const plan = sqlite.prepare(`SELECT statement FROM revision_plan WHERE kind='qcm' AND lower(topic) IN (${ph})`).all(...labels) as { statement: string }[];
  return [...bank, ...plan].map((r) => r.statement).filter(Boolean);
}

/** Re-tague les lignes parcours existantes dont le topic est un ALIAS → label canonique + rank du thème
 *  (fusion vers la taxonomie de programme ; aucun contenu supprimé, on ré-étiquette l'ordre). */
function normalizeExistingTopics(): void {
  const upd = sqlite.prepare(`UPDATE revision_plan SET topic = ?, lecture_rank = ? WHERE topic = ?`);
  const tx = sqlite.transaction(() => {
    for (const t of REVISION_THEMES) for (const a of t.aliases) if (a !== t.label) upd.run(t.label, t.rank, a);
    // aligne aussi le rank des lignes déjà au label canonique
    const updRank = sqlite.prepare(`UPDATE revision_plan SET lecture_rank = ? WHERE topic = ?`);
    for (const t of REVISION_THEMES) updRank.run(t.rank, t.label);
  });
  tx();
}

const META_TRAPS = `Méta-pièges de l'étudiant à rejouer de temps en temps (style « vrai/faux à justifier ») : (1) la loss suit la TÂCHE, pas le mot « regression » ; (2) une affirmation enchaînée n'est vraie que si TOUTE la chaîne tient (pas seulement la 1ʳᵉ moitié) ; (3) « can be used » ≠ « best » → lis le verbe exact ; (4) ne pas REJETER une affirmation vraie sous prétexte que la justification n'est pas « le vrai facteur ».`;

function guidanceFor(t: Theme, covered: string[]): string {
  const recap = covered.slice(-22).map((s, i) => `  ${i + 1}. ${s.slice(0, 150)}`).join("\n");
  return [
    t.weak ? `CIBLAGE FAIBLESSES (CS-233) — bâtis les DISTRACTEURS sur ces idées fausses RÉELLES de l'étudiant (ce sont les pièges où il se trompe ; chaque distracteur doit punir un de ces réflexes faux) :\n${t.weak}` : null,
    META_TRAPS,
    covered.length ? `ANTI-DOUBLON STRICT — ces énoncés sont DÉJÀ couverts (banque + parcours). Ne les répète NI ne les paraphrase ; change réellement d'angle (calcul, intuition, cas-limite, comparaison de méthodes, lecture de figure) :\n${recap}` : null,
  ].filter(Boolean).join("\n\n");
}

/** Compte les QCM/ouvertes existants du parcours pour un thème (canonique + alias). */
function planCountForTheme(t: Theme): { qcm: number; open: number } {
  const labels = themeLabels(t).map((l) => l.toLowerCase());
  const ph = labels.map(() => "?").join(",");
  const qcm = (sqlite.prepare(`SELECT count(*) n FROM revision_plan WHERE kind='qcm' AND lower(topic) IN (${ph})`).get(...labels) as { n: number }).n;
  const open = (sqlite.prepare(`SELECT count(*) n FROM revision_plan WHERE kind='open' AND lower(topic) IN (${ph})`).get(...labels) as { n: number }).n;
  return { qcm, open };
}

/**
 * ÉTEND le parcours (ADDITIF — ne supprime rien) jusqu'à `perTopic` QCM MIN par thème (plus pour les
 * thèmes lourds/faibles via `target`), + `openPerTopic` ouvertes. Réentrant : recompte l'existant et
 * ne génère que le manque → relançable pour grossir. Résilient : un lot raté est loggé puis ignoré.
 * Exporte le JSON après CHAQUE thème (vague) via `onWave`.
 */
export async function extendParcours(opts: {
  perTopic?: number; openPerTopic?: number; onlyRank?: number; onStep?: StepCb;
  onWave?: (theme: string, qcm: number, open: number) => void;
} = {}): Promise<{ themes: number; qcmAdded: number; openAdded: number }> {
  ensureRevisionSchema();
  const step = opts.onStep ?? (() => {});
  const perTopic = opts.perTopic ?? 10;
  const openPerTopic = opts.openPerTopic ?? 4;
  normalizeExistingTopics();
  const { architectQuestion } = await import("@/lib/architect");
  const { profile } = await import("@/lib/course-profile");
  const archs = profile().archetypes as any[];

  const insQ = sqlite.prepare(`INSERT INTO revision_plan (kind, topic, lecture_rank, statement, options, correct, misconceptions, explanation, verified, verify_method) VALUES ('qcm',?,?,?,?,?,?,?,?,?)`);
  const insO = sqlite.prepare(`INSERT INTO revision_plan (kind, topic, lecture_rank, statement, solution, verified, verify_method) VALUES ('open',?,?,?,?,?,?)`);

  let qcmAdded = 0, openAdded = 0, themesDone = 0;
  const themes = REVISION_THEMES.filter((t) => opts.onlyRank == null || t.rank === opts.onlyRank);

  for (let ti = 0; ti < themes.length; ti++) {
    const t = themes[ti];
    const baseProg = Math.round((ti / themes.length) * 100);
    const target = Math.max(perTopic, t.target);
    const have = planCountForTheme(t);
    let need = Math.max(0, target - have.qcm);
    let needOpen = Math.max(0, openPerTopic - have.open);
    step(`▶ ${t.label} (L${t.rank}) — a ${have.qcm} QCM/${have.open} ouv., cible ${target}/${openPerTopic} → +${need} QCM /+${needOpen} ouv.`, baseProg);

    // énoncés déjà couverts (banque + parcours) → dédup + anti-répétition dans le prompt
    const covered = coveredStemsForTheme(t);
    const coveredSets = covered.map(tokens);
    let qThis = 0, oThis = 0, guard = 0;

    // ── QCM : vagues de 6, ciblées sur le thème (focus) + faiblesses (guidance), vérif à l'aveugle ──
    while (need > 0 && guard < 8) {
      guard++;
      const batch = Math.min(6, need);
      try {
        const guidance = guidanceFor(t, covered);
        let items = await generateQcmBatch([{ label: t.label, method: null }], batch, () => {}, t.label, guidance);
        try { items = await verifyQcmBatch(items, () => {}); } catch {}
        let inserted = 0;
        for (const it of items) {
          if (!it.stem || !(it.options ?? []).length) continue;
          const st = tokens(it.stem);
          if (coveredSets.some((c) => jaccard(c, st) > 0.72)) continue; // quasi-doublon → skip
          const optStr = (it.options ?? []).map((o, k) => `${LETTERS[k]}) ${o}`).join("\n");
          const correct = (it.correct ?? []).map((c) => LETTERS[c] ?? "?").join(", ");
          insQ.run(t.label, t.rank, it.stem, optStr, correct, JSON.stringify(it.misconceptions ?? []), it.explanation ?? null, it.verified ?? null, it.verified === 1 ? "qcm-blind-verify" : null);
          covered.push(it.stem); coveredSets.push(st);
          inserted++; qThis++; qcmAdded++; need--;
          if (need <= 0) break;
        }
        step(`  ${t.label} — +${inserted} QCM (lot ${guard}), reste ${need}`, baseProg);
        if (inserted === 0) break; // le modèle ne produit que des doublons → on arrête ce thème
      } catch (e) { step(`  ${t.label} — lot QCM ignoré (${(e as Error).message.slice(0, 40)})`, baseProg); break; }
    }

    // ── OUVERTES : architecte (multi-passes + vérif), style du prof, sur le thème ──
    for (let k = 0; k < needOpen; k++) {
      try {
        const a = archs[(ti + k) % archs.length];
        const focus = t.weak ? `${t.label} — insiste sur : ${t.weak.slice(0, 240)}` : t.label;
        const r = await architectQuestion(a, focus, 15, { maxRounds: 1 });
        const st = tokens(r.q.statement_tex ?? "");
        if (coveredSets.some((c) => jaccard(c, st) > 0.72)) continue;
        insO.run(t.label, t.rank, r.q.statement_tex, r.q.solution_tex, 1, "architect");
        coveredSets.push(st); oThis++; openAdded++;
      } catch (e) { step(`  ${t.label} — ouverte ignorée (${(e as Error).message.slice(0, 40)})`, baseProg); }
    }

    themesDone++;
    step(`✓ ${t.label} : +${qThis} QCM, +${oThis} ouvertes`, baseProg);
    opts.onWave?.(t.label, qThis, oThis);
  }
  return { themes: themesDone, qcmAdded, openAdded };
}

/** Compte par THÈME du programme (canonique + alias) — preuve de couverture/volume. */
export function themeCoverage(): { label: string; rank: number; target: number; qcm: number; open: number; weak: boolean }[] {
  ensureRevisionSchema();
  return REVISION_THEMES.map((t) => {
    const c = planCountForTheme(t);
    return { label: t.label, rank: t.rank, target: Math.max(10, t.target), qcm: c.qcm, open: c.open, weak: !!t.weak };
  });
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

