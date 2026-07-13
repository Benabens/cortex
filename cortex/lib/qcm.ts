import { currentCourse, sqlite } from "@/db/client";
import { completeText, extractJson } from "@/lib/llm";
import { courseRefImages } from "@/lib/course-vision";
import type { ExamQuestion, StepCb } from "@/lib/exam";
import { getFormatProfile } from "@/lib/format";
import { calibrationBlock } from "@/lib/calibration";

/**
 * V6 — ARCHITECTE QCM (générique). Génère des QCM de haut niveau au format détecté :
 *  - chaque distracteur cible une IDÉE FAUSSE précise (pas du remplissage) ;
 *  - exactement UNE bonne réponse (SCQ) ou le sous-ensemble correct (MCQ), VÉRIFIÉ À L'AVEUGLE ;
 *  - ZÉRO indice qui trahit (option correcte ni plus longue ni plus détaillée, pas de « toutes les
 *    réponses ci-dessus », cohérence grammaticale, pas de distracteur absurde) ;
 *  - teste la COMPRÉHENSION, pas le par-cœur.
 *
 * Persisté dans `qcm_items` (par exam). La correction est instantanée (clé connue, Pilier E).
 */

export type QcmItem = {
  topic: string;
  type: "scq" | "mcq";
  stem: string;
  options: string[];
  correct: number[]; // indices 0-based ; 1 pour scq, ≥1 pour mcq
  misconceptions: string[]; // par option : l'idée fausse que le distracteur cible ("" pour la/les bonnes)
  explanation: string;
  verified: 0 | 1 | null;
};

const QCM_BATCH_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic: { type: "string" },
          type: { type: "string", description: "scq (une seule bonne réponse) | mcq (une ou plusieurs)" },
          stem: { type: "string", description: "L'énoncé de la question (teste la compréhension, pas le par-cœur)." },
          options: { type: "array", items: { type: "string" }, description: "4 à 5 options, longueurs COMPARABLES, pas d'« toutes les réponses ci-dessus »." },
          correct: { type: "array", items: { type: "integer" }, description: "Indices 0-based de la/des bonne(s) réponse(s). Exactement 1 pour scq." },
          misconceptions: { type: "array", items: { type: "string" }, description: "Pour CHAQUE option : l'idée fausse précise que ce distracteur punit (chaîne vide pour les bonnes réponses)." },
          explanation: { type: "string", description: "Pourquoi la bonne réponse est correcte ET pourquoi chaque distracteur est faux." },
        },
        required: ["topic", "type", "stem", "options", "correct", "misconceptions", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

function ensureQcmSchema() {
  // l'examen QCM s'insère dans `exams` (partagée) ; garantir la colonne verify_summary (les DB de
  // cours créées hors cs-202 ne l'ont pas — ensureExamCols n'a pas tourné).
  sqlite.exec(`CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')),
    format_template TEXT, targeted_weakness_ids TEXT, html_path TEXT, status TEXT DEFAULT 'draft');`);
  const cols = (sqlite.prepare(`PRAGMA table_info(exams)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("verify_summary")) sqlite.exec(`ALTER TABLE exams ADD COLUMN verify_summary TEXT`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS exam_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, exam_id INTEGER NOT NULL, concept TEXT,
    statement_html TEXT, solution_html TEXT, source_inspiration TEXT, verified INTEGER, verify_issue TEXT);`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS qcm_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    topic TEXT,
    type TEXT,
    stem TEXT,
    options_json TEXT,
    correct_json TEXT,
    misconceptions_json TEXT,
    explanation TEXT,
    verified INTEGER
  );`);
}

/** Sujets à couvrir : blueprint (topics pondérés) si dispo, sinon archétypes du cours. */
function coverageTopics(): { label: string; method: string | null }[] {
  try {
    const rows = sqlite.prepare(`SELECT label, method FROM topics ORDER BY exam_weight DESC LIMIT 14`).all() as { label: string; method: string | null }[];
    if (rows.length) return rows;
  } catch {}
  const { profile } = require("@/lib/course-profile");
  return (profile().archetypes as any[]).map((a) => ({ label: a.concept, method: a.structure }));
}

const ARCHITECT_QCM_RULES = [
  `RÈGLES D'ARCHITECTE QCM (impératives) :`,
  `  - Chaque DISTRACTEUR cible une IDÉE FAUSSE réelle et précise (une mauvaise intuition courante), JAMAIS du remplissage ni de l'absurde.`,
  `  - SCQ : EXACTEMENT une bonne réponse. MCQ : le sous-ensemble correct (≥1), selon la convention du format.`,
  `  - AUCUN indice qui trahit : la bonne option n'est ni plus longue ni plus détaillée ; pas de « toutes les réponses ci-dessus » ; cohérence grammaticale stem↔options ; options de longueur comparable ; pas de négations piégeuses gratuites.`,
  `  - Teste la COMPRÉHENSION / le raisonnement, pas la récitation d'une définition.`,
  `  - Calibre la difficulté sur les VRAIS examens du cours (regarde les pages fournies).`,
];

/** Génère un LOT de QCM (1 appel Max) couvrant des sujets donnés, au format du cours.
 *  `guidance` (optionnel, additif) : consignes supplémentaires injectées dans le prompt — sert au
 *  parcours de révision pour (a) bâtir des distracteurs sur les ERREURS RÉELLES de l'étudiant et
 *  (b) lister les énoncés déjà couverts à NE PAS répéter. Absent → comportement identique à avant. */
export async function generateQcmBatch(topics: { label: string; method: string | null }[], n: number, step: StepCb, focus?: string, guidance?: string): Promise<QcmItem[]> {
  const fmt = getFormatProfile();
  const imgs = courseRefImages().slice(0, 4);
  const { profile } = require("@/lib/course-profile");
  // V9 P3 — boucle FERMÉE : la mémoire de calibration des QCM (« trop facile / pas le style / faux »)
  // est réinjectée à la CONCEPTION → durcit/réoriente réellement les QCM suivants.
  const calib = calibrationBlock("qcm");
  const coverage = focus
    ? `Toutes ces ${n} questions portent sur le thème CIBLÉ : « ${focus} » — varie les SOUS-ANGLES / sous-notions de ce thème (pas ${n} fois la même question).`
    : `Couvre ces sujets (un QCM par sujet si possible, dans l'ordre) : ${topics.slice(0, n).map((t, i) => `${i + 1}) ${t.label}${t.method ? ` [${t.method.slice(0, 60)}]` : ""}`).join(" · ")}`;
  const prompt = [
    profile().qaIntro?.() ?? "Tu es l'équipe enseignante du cours.",
    `Tu rédiges ${n} QCM INÉDITS de niveau examen pour ce cours, au FORMAT réel détecté.`,
    fmt ? `Format du cours : ${fmt.format_summary} — convention SCQ/MCQ : ${fmt.scq_vs_mcq_convention}.` : ``,
    imgs.length ? `Pages d'examens réelles à imiter (outil Read) :\n${imgs.map((p) => `  - ${p}`).join("\n")}` : ``,
    ``,
    ...ARCHITECT_QCM_RULES,
    calib || null,
    ``,
    coverage,
    guidance ? `\n${guidance}` : null,
    `Réponds UNIQUEMENT avec l'objet JSON { "items": [ … ] } (${n} QCM). Aucun fichier.`,
    JSON.stringify(QCM_BATCH_SCHEMA, null, 2),
  ].filter((l) => l != null && l !== false && l !== "").join("\n");
  step(`Génération de ${n} QCM (architecte · distracteurs = idées fausses)…`, 30);
  const r = extractJson<{ items: QcmItem[] }>(await completeText({ prompt, model: "opus", timeoutMs: 480_000 }));
  return (r.items ?? []).map((q) => ({ ...q, verified: null as 0 | 1 | null }));
}

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          correct: { type: "array", items: { type: "integer" }, description: "La/les bonne(s) réponse(s) que TOI tu trouves, en résolvant indépendamment." },
          ok: { type: "boolean", description: "true si ta réponse == la clé proposée ET qu'il n'y a pas d'ambiguïté/indice qui trahit." },
          issue: { type: "string", description: "Court : ce qui cloche (clé fausse, 2 réponses défendables, indice qui trahit, distracteur absurde). Vide si ok." },
        },
        required: ["index", "correct", "ok"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

/** Vérif à l'aveugle d'un lot de QCM : résous chaque QCM SANS la clé, confirme/corrige la clé. */
export async function verifyQcmBatch(items: QcmItem[], step: StepCb): Promise<QcmItem[]> {
  const { profile } = require("@/lib/course-profile");
  const blind = items.map((q, i) => `Q${i}. [${q.type}] ${q.stem}\n${q.options.map((o, k) => `   (${k}) ${o}`).join("\n")}`).join("\n\n");
  // V9 P3 — la mémoire de calibration des QCM est aussi réinjectée à la CRITIQUE : un « trop facile »
  // passé rend la vérif plus sévère sur la trivialité/les indices qui trahissent.
  const calib = calibrationBlock("qcm");
  const prompt = [
    `Tu es un correcteur rigoureux du cours. Pour CHAQUE QCM ci-dessous, RÉSOUS-LE toi-même de zéro (sans clé fournie) et donne la/les bonne(s) réponse(s) par INDEX.`,
    `Signale si : la question est ambiguë (2 réponses défendables), un distracteur est absurde, ou un indice trahit la bonne réponse (longueur, « toutes les réponses », grammaire).`,
    calib ? `${calib}\nÀ la lumière de ces leçons, sois SÉVÈRE : signale aussi (issue) tout QCM trop trivial / au distracteur trop faible si l'étudiant a jugé ce type « trop facile ».` : null,
    ``,
    blind,
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON conforme.`,
    JSON.stringify(VERIFY_SCHEMA, null, 2),
  ].filter((l) => l != null).join("\n");
  step("Vérification à l'aveugle des QCM (résolution indépendante)…", 70);
  let res: { results: { index: number; correct: number[]; ok: boolean; issue?: string }[] };
  try { res = extractJson(await completeText({ prompt, model: "opus", timeoutMs: 420_000 })); }
  catch { return items; } // fallback honnête : non vérifiés
  for (const r of res.results ?? []) {
    const q = items[r.index];
    if (!q) continue;
    const keyMatch = JSON.stringify([...(q.correct ?? [])].sort()) === JSON.stringify([...(r.correct ?? [])].sort());
    if (r.ok && keyMatch) q.verified = 1;
    else if (r.correct?.length) { q.correct = r.correct; q.verified = 1; q.explanation = (q.explanation ? q.explanation + " " : "") + (r.issue ? `[clé corrigée à la vérif : ${r.issue}]` : "[clé alignée sur la résolution indépendante]"); }
    else q.verified = 0;
  }
  return items;
}

export type QcmExamResult = { id: number; count: number; verified: number; open: number; pdf?: string; texError?: string };

/** Génère un examen QCM complet (N QCM + M ouvertes), vérifié, persisté, rendu en PDF.
 *  `count`/`openCount` : la COMPOSITION choisie par Ben (composeur V9). `focus` : thème ciblé
 *  optionnel (exercice ciblé V9 — toutes les questions portent dessus). */
export async function generateQcmExam(opts: { count?: number; openCount?: number; focus?: string; onStep?: StepCb } = {}): Promise<QcmExamResult> {
  ensureQcmSchema();
  const step = opts.onStep ?? (() => {});
  const fmt = getFormatProfile();
  const focus = (opts.focus ?? "").trim() || undefined;
  const qcmShare = (fmt?.question_types ?? []).filter((t) => t.type === "scq" || t.type === "mcq").reduce((s, t) => s + (t.approx_count || 0), 0);
  // count peut être 0 (drill « 0 QCM + 1 ouvert ») → on respecte le choix explicite ; sinon défaut détecté.
  const count = Math.max(0, opts.count ?? Math.min(20, Math.max(8, qcmShare || 12)));
  const openCount = Math.max(0, opts.openCount ?? Math.min(3, Math.max(0, (fmt?.question_types ?? []).find((t) => t.type === "open")?.approx_count ?? 2)));
  if (count === 0 && openCount === 0) throw new Error("Composition vide : choisis au moins 1 QCM ou 1 question ouverte.");
  // focus ciblé → toutes les questions sur ce thème ; sinon couverture large du programme.
  const topics = focus ? [{ label: focus, method: null as string | null }] : coverageTopics();
  step(`Architecte : ${count} QCM + ${openCount} question(s) ouverte(s)${focus ? ` sur « ${focus} »` : " au format détecté"}…`, 8);

  // lots de 4 QCM en parallèle borné (2 lots à la fois). RÉSILIENT : un lot qui échoue (JSON
  // malformé du modèle sur du math) est réessayé une fois puis IGNORÉ — il ne plante pas le job.
  const BATCH = 4;
  const batches: { label: string; method: string | null }[][] = [];
  for (let i = 0; i < count; i += BATCH) {
    const slice: { label: string; method: string | null }[] = [];
    for (let k = 0; k < BATCH && i + k < count; k++) slice.push(topics[(i + k) % topics.length]);
    batches.push(slice);
  }
  const safeBatch = async (bt: { label: string; method: string | null }[]): Promise<QcmItem[]> => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const items = await generateQcmBatch(bt, bt.length, step, focus);
        if (items.length) return await verifyQcmBatch(items, step);
      } catch (e) {
        step(`Lot QCM échoué (${(e as Error).message.slice(0, 50)})${attempt < 2 ? " — réessai" : " — ignoré"}`, 0);
      }
    }
    return [];
  };
  const all: QcmItem[] = [];
  for (let b = 0; b < batches.length; b += 2) {
    const got = await Promise.all(batches.slice(b, b + 2).map(safeBatch));
    for (const g of got) all.push(...g);
    step(`${all.length}/${count} QCM construits + vérifiés…`, 30 + Math.round((all.length / Math.max(1, count)) * 50));
  }
  // count>0 mais 0 QCM produit = tous les lots ont échoué → erreur claire (sauf drill 0 QCM + ouvertes).
  if (count > 0 && !all.length) throw new Error("Aucun QCM généré (tous les lots ont échoué). Réessaie.");

  // partie OUVERTE (V7) : chaque question via l'architecte (multi-passes + vérif), au niveau réel.
  const openQs: ExamQuestion[] = [];
  if (openCount > 0) {
    const { architectQuestion } = await import("@/lib/architect");
    const { profile } = require("@/lib/course-profile");
    const archs = profile().archetypes as any[];
    for (let i = 0; i < openCount; i++) {
      const t = topics[(count + i) % topics.length];
      const a = archs[i % archs.length];
      step(`Question ouverte ${i + 1}/${openCount} (architecte) — ${t.label}…`, 82 + i);
      try {
        const r = await architectQuestion(a, `${t.label}${t.method ? ` — ${t.method}` : ""}`, 15, { maxRounds: 1, onStep: (m) => step(`Ouverte ${i + 1} · ${m}`, 82 + i) });
        openQs.push({ ...r.q, points: 15 });
      } catch (e) { step(`Question ouverte ${i + 1} ignorée : ${(e as Error).message.slice(0, 60)}`, 82 + i); }
    }
  }

  if (!all.length && !openQs.length) throw new Error("Rien n'a pu être généré (lots QCM et questions ouvertes échoués). Réessaie.");

  // persiste l'exam + les QCM + les ouvertes
  const examId = sqlite.prepare(`INSERT INTO exams (format_template, status) VALUES ('qcm','ready')`).run().lastInsertRowid as number;
  const ins = sqlite.prepare(`INSERT INTO qcm_items (exam_id, idx, topic, type, stem, options_json, correct_json, misconceptions_json, explanation, verified) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insOpen = sqlite.prepare(`INSERT INTO exam_questions (exam_id, concept, statement_html, solution_html, source_inspiration) VALUES (?,?,?,?,?)`);
  const tx = sqlite.transaction(() => {
    all.forEach((q, i) => ins.run(examId, i, q.topic, q.type, q.stem, JSON.stringify(q.options), JSON.stringify(q.correct), JSON.stringify(q.misconceptions), q.explanation, q.verified));
    openQs.forEach((q) => insOpen.run(examId, q.concept, q.statement_tex, q.solution_tex, "qcm-open"));
  });
  tx();
  const verified = all.filter((q) => q.verified === 1).length;
  sqlite.prepare(`UPDATE exams SET verify_summary = ? WHERE id = ?`).run(`QCM ${all.length} (${verified} vér.) + ${openQs.length} ouverte(s)`, examId);

  // rendu PDF (énoncé + corrigé) au look d'un vrai final du cours
  step("Rendu du PDF (look vrai final)…", 92);
  let pdf: string | undefined, texError: string | undefined;
  try {
    const { buildQcmArtifact } = await import("@/lib/qcm-latex");
    const dateLabel = (sqlite.prepare(`SELECT date('now') d`).get() as any).d;
    const out = await buildQcmArtifact(examId, { items: all, open: openQs }, dateLabel);
    pdf = out.file; texError = out.texError;
    sqlite.prepare(`UPDATE exams SET html_path = ? WHERE id = ?`).run(out.file, examId);
  } catch (e) { texError = (e as Error).message; }

  step(`Examen QCM #${examId} prêt — ${all.length} QCM + ${openQs.length} ouverte(s) ✓`, 100);
  return { id: examId, count: all.length, verified, open: openQs.length, pdf, texError };
}

export type QcmOpenView = { id: number; concept: string; statement: string; solution: string };
export type QcmExamView = { id: number; createdAt: string; verifySummary: string | null; pdf: string | null; items: (Omit<QcmItem, "correct" | "misconceptions"> & { id: number; idx: number })[]; open: QcmOpenView[] };

/** Un examen QCM pour l'affichage (SANS les clés — l'auto-correction se fait via /api). */
export function getQcmExam(examId: number, withKeys = false): QcmExamView | null {
  ensureQcmSchema();
  const e = sqlite.prepare(`SELECT id, created_at, verify_summary, html_path FROM exams WHERE id = ? AND format_template = 'qcm'`).get(examId) as any;
  if (!e) return null;
  const rows = sqlite.prepare(`SELECT * FROM qcm_items WHERE exam_id = ? ORDER BY idx`).all(examId) as any[];
  let open: QcmOpenView[] = [];
  try {
    const { texToHtml } = require("@/lib/exam-latex");
    open = (sqlite.prepare(`SELECT id, concept, statement_html, solution_html FROM exam_questions WHERE exam_id = ? AND source_inspiration = 'qcm-open' ORDER BY id`).all(examId) as any[])
      .map((r) => ({ id: r.id, concept: r.concept, statement: texToHtml(r.statement_html ?? ""), solution: withKeys ? texToHtml(r.solution_html ?? "") : "" }));
  } catch {}
  return {
    id: e.id, createdAt: e.created_at, verifySummary: e.verify_summary, pdf: e.html_path ?? null,
    items: rows.map((r) => ({
      id: r.id, idx: r.idx, topic: r.topic, type: r.type, stem: r.stem,
      options: JSON.parse(r.options_json), explanation: withKeys ? r.explanation : "", verified: r.verified,
      ...(withKeys ? { correct: JSON.parse(r.correct_json), misconceptions: JSON.parse(r.misconceptions_json) } : {}),
    })) as any,
    open,
  };
}

/** Corrige des réponses {idx: number[]} contre la clé connue → score + détail (Pilier E). */
export function gradeQcm(examId: number, answers: Record<number, number[]>): { score: number; total: number; detail: { idx: number; correct: number[]; chosen: number[]; ok: boolean; explanation: string; misconceptions: string[] }[] } {
  ensureQcmSchema();
  const rows = sqlite.prepare(`SELECT idx, correct_json, explanation, misconceptions_json FROM qcm_items WHERE exam_id = ? ORDER BY idx`).all(examId) as any[];
  const detail = rows.map((r) => {
    const correct: number[] = JSON.parse(r.correct_json);
    const chosen = (answers[r.idx] ?? []).slice().sort();
    const ok = JSON.stringify(correct.slice().sort()) === JSON.stringify(chosen);
    return { idx: r.idx, correct, chosen, ok, explanation: r.explanation, misconceptions: JSON.parse(r.misconceptions_json) };
  });
  return { score: detail.filter((d) => d.ok).length, total: rows.length, detail };
}
