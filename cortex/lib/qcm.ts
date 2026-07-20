import { q, nowStr } from "@/db/q";
import { completeText, extractJson } from "@/lib/llm";
import { courseRefImages } from "@/lib/course-vision";
import type { ExamQuestion, StepCb } from "@/lib/exam";
import { getFormatProfile } from "@/lib/format";
import { calibrationBlock } from "@/lib/calibration";
import { getExamDna, sampleMolds, pickCoverage, fewShotForMold, type ExamDna } from "@/lib/exam-dna";
import { MOLD_DEFS, normalizeMold, type MoldKind } from "@/lib/molds";
import { renderFigure, figureSpecPromptBlock, type FigureSpec } from "@/lib/figure-gen";
import { examsDir } from "@/lib/paths";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
  // moteur-v2 — MOULE de la question (échantillonné depuis l'ADN détecté) + figure éventuelle
  // (spec générique rendue en PNG sandboxé ; truth = valeurs que la figure fixe, pour la vérif).
  mold?: MoldKind | null;
  figureSpec?: FigureSpec | null;
  figureFile?: string | null;
  figureTruth?: Record<string, number> | null;
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
          mold: { type: "string", description: "Recopie le MOULE imposé pour cette question (voir la consigne par question)." },
          figure_spec: { type: "object", description: "UNIQUEMENT si la question exige une figure data/plot (moule figure_reading) : le FIGURE SPEC JSON décrit dans le prompt. Sinon omets ce champ." },
        },
        required: ["topic", "type", "stem", "options", "correct", "misconceptions", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

async function ensureQcmSchema(): Promise<void> {
  // l'examen QCM s'insère dans `exams` (partagée) ; garantir la colonne verify_summary (les DB de
  // cours créées hors cs-202 ne l'ont pas — ensureExamCols n'a pas tourné). DDL canonique : db/tables.ts.
  await q.ensureTable("exams");
  await q.ensureColumns("exams", ["verify_summary"]);
  await q.ensureTable("exam_questions");
  await q.ensureTable("qcm_items");
  // moteur-v2 — moule + figure (spec/fichier/truth) par item, additif.
  await q.ensureColumns("qcm_items", ["mold", "figure_json"]);
}

/** Sujets à couvrir : blueprint (topics pondérés) si dispo, sinon archétypes du cours.
 *  moteur-v2 (P2) — retourne TOUTE la liste ordonnée par poids (plus de LIMIT 14 : la LARGEUR
 *  est gérée à l'échantillonnage par pickCoverage, qui inclut la longue traîne). */
async function coverageTopics(): Promise<{ label: string; method: string | null }[]> {
  try {
    const rows = await q.all<{ label: string; method: string | null }>(`SELECT label, method FROM topics ORDER BY exam_weight DESC, exam_count DESC, label`);
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
 *  (b) lister les énoncés déjà couverts à NE PAS répéter. Absent → comportement identique à avant.
 *  moteur-v2 — `opts.molds` (aligné aux topics) impose le MOULE de chaque question (ADN détecté) ;
 *  `opts.dna` active les figures (data-driven : seulement si le cours en a) + le cadrage appliqué. */
export async function generateQcmBatch(
  topics: { label: string; method: string | null }[],
  n: number,
  step: StepCb,
  focus?: string,
  guidance?: string,
  opts: { molds?: (MoldKind | null)[]; dna?: ExamDna | null } = {}
): Promise<QcmItem[]> {
  const fmt = await getFormatProfile();
  const imgs = courseRefImages().slice(0, 4);
  const { profile } = require("@/lib/course-profile");
  // V9 P3 — boucle FERMÉE : la mémoire de calibration des QCM (« trop facile / pas le style / faux »)
  // est réinjectée à la CONCEPTION → durcit/réoriente réellement les QCM suivants.
  const calib = await calibrationBlock("qcm");
  const molds = opts.molds ?? [];
  const withFigures = (opts.dna?.figures.kinds.length ?? 0) > 0;
  const moldLine = (i: number) => {
    const m = molds[i] ?? null;
    return m ? ` — MOULE IMPOSÉ : ${m} (${MOLD_DEFS[m]})` : "";
  };
  const coverage = focus
    ? `Toutes ces ${n} questions portent sur le thème CIBLÉ : « ${focus} » — varie les SOUS-ANGLES / sous-notions de ce thème (pas ${n} fois la même question).${molds.some(Boolean) ? ` Moules imposés dans l'ordre : ${molds.slice(0, n).map((m) => m ?? "libre").join(", ")}.` : ""}`
    : `Couvre ces sujets (un QCM par sujet, dans l'ordre) :\n${topics.slice(0, n).map((t, i) => `  ${i + 1}) ${t.label}${t.method ? ` [${t.method.slice(0, 60)}]` : ""}${moldLine(i)}`).join("\n")}`;
  // P3 — imitation resserrée : de VRAIES questions des mêmes moules dans CE cours (few-shot).
  const distinctMolds = [...new Set(molds.slice(0, n).filter((m): m is MoldKind => !!m))].slice(0, 3);
  const fewShots: string[] = [];
  for (const m of distinctMolds) {
    const ex = await fewShotForMold(m, 2);
    if (ex.length) fewShots.push(`  ${m} :\n${ex.map((e) => `    · ${e}`).join("\n")}`);
  }
  // texture de difficulté détectée (ADN) — jamais inventée.
  const texture = opts.dna?.difficulty
    ? `TEXTURE DE DIFFICULTÉ observée dans les annales : ${opts.dna.difficulty.summary}${opts.dna.difficulty.typical_traps.length ? ` Pièges typiques : ${opts.dna.difficulty.typical_traps.slice(0, 4).join(" · ")}` : ""}`
    : null;
  const prompt = [
    profile().qaIntro?.() ?? "Tu es l'équipe enseignante du cours.",
    `Tu rédiges ${n} QCM INÉDITS de niveau examen pour ce cours, au FORMAT réel détecté.`,
    fmt ? `Format du cours : ${fmt.format_summary} — convention SCQ/MCQ : ${fmt.scq_vs_mcq_convention}.` : ``,
    imgs.length ? `Pages d'examens réelles à imiter (outil Read) :\n${imgs.map((p) => `  - ${p}`).join("\n")}` : ``,
    ``,
    ...ARCHITECT_QCM_RULES,
    `  - RESPECTE le MOULE imposé de chaque question (recopie-le dans "mold"). Sauf pour le moule statement_truefalse, ANCRE la question dans un scénario concret ou un mini-calcul de l'idiome du cours (jamais une affirmation abstraite hors-sol).`,
    withFigures ? `  - Pour un moule figure_reading : ÉMETS "figure_spec" (contrat ci-dessous) — la question doit être RÉSOLUBLE depuis la figure seule.` : null,
    calib || null,
    texture,
    fewShots.length ? `\nVRAIES questions de ces moules dans CE cours (imite le STYLE et l'ancrage — ne copie JAMAIS l'énoncé) :\n${fewShots.join("\n")}` : null,
    withFigures ? `\n${figureSpecPromptBlock()}` : null,
    ``,
    coverage,
    guidance ? `\n${guidance}` : null,
    `Réponds UNIQUEMENT avec l'objet JSON { "items": [ … ] } (${n} QCM). Aucun fichier.`,
    JSON.stringify(QCM_BATCH_SCHEMA, null, 2),
  ].filter((l) => l != null && l !== false && l !== "").join("\n");
  step(`Génération de ${n} QCM (architecte · moules + idées fausses)…`, 30);
  const r = extractJson<{ items: (QcmItem & { figure_spec?: FigureSpec })[] }>(await completeText({ prompt, model: "opus", timeoutMs: 480_000 }));
  const items: QcmItem[] = [];
  for (let i = 0; i < (r.items ?? []).length; i++) {
    const raw = r.items[i];
    const imposed = molds[i] ?? null;
    const it: QcmItem = {
      ...raw,
      verified: null,
      mold: normalizeMold(raw.mold) ?? imposed,
      figureSpec: null,
      figureFile: null,
      figureTruth: null,
    };
    // figure : rendu SANDBOX immédiat (le vérifieur doit la VOIR). Échec de rendu →
    // question de lecture de figure inutilisable → item écarté (résilient) ; sinon figure retirée.
    const spec = (raw as { figure_spec?: FigureSpec }).figure_spec;
    if (spec && typeof spec === "object") {
      const rf = await renderFigure({ ...spec, kind: "plot" });
      if (rf.ok && rf.pngB64) {
        const file = `qcm-fig-${crypto.randomUUID().slice(0, 8)}.png`;
        fs.mkdirSync(examsDir(), { recursive: true });
        fs.writeFileSync(path.join(examsDir(), file), Buffer.from(rf.pngB64, "base64"));
        it.figureSpec = { ...spec, kind: "plot" };
        it.figureFile = file;
        it.figureTruth = rf.truth ?? null;
      } else if (it.mold === "figure_reading") {
        step(`QCM figure_reading écarté (rendu figure : ${rf.reason ?? "échec"})`, 30);
        continue;
      }
    } else if (it.mold === "figure_reading" && withFigures) {
      // moule figure imposé mais aucune spec émise → question probablement non résoluble « depuis la figure » → écartée.
      continue;
    }
    items.push(it);
  }
  return items;
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

/** Vérif à l'aveugle d'un lot de QCM : résous chaque QCM SANS la clé, confirme/corrige la clé.
 *  moteur-v2 (P4) — les questions à FIGURE sont re-résolues DEPUIS la figure (vision : le solveur
 *  ouvre le PNG rendu) ; sans quoi une question de lecture de figure serait jugée au hasard. */
export async function verifyQcmBatch(items: QcmItem[], step: StepCb): Promise<QcmItem[]> {
  const { profile } = require("@/lib/course-profile");
  const blind = items.map((q, i) =>
    `Q${i}. [${q.type}]${q.figureFile ? ` [FIGURE : ouvre ${path.join(path.relative(process.cwd(), examsDir()), q.figureFile)} avec l'outil Read]` : ""} ${q.stem}\n${q.options.map((o, k) => `   (${k}) ${o}`).join("\n")}`
  ).join("\n\n");
  const figDirs = items.some((q) => q.figureFile) ? [examsDir()] : [];
  // V9 P3 — la mémoire de calibration des QCM est aussi réinjectée à la CRITIQUE : un « trop facile »
  // passé rend la vérif plus sévère sur la trivialité/les indices qui trahissent.
  const calib = await calibrationBlock("qcm");
  const prompt = [
    `Tu es un correcteur rigoureux du cours. Pour CHAQUE QCM ci-dessous, RÉSOUS-LE toi-même de zéro (sans clé fournie) et donne la/les bonne(s) réponse(s) par INDEX.`,
    `Signale si : la question est ambiguë (2 réponses défendables), un distracteur est absurde, ou un indice trahit la bonne réponse (longueur, « toutes les réponses », grammaire).`,
    figDirs.length ? `Certaines questions ont une FIGURE : OUVRE le PNG indiqué (outil Read) et résous DEPUIS la figure. Si la figure ne suffit pas à répondre, mets ok=false avec issue="figure insuffisante".` : null,
    calib ? `${calib}\nÀ la lumière de ces leçons, sois SÉVÈRE : signale aussi (issue) tout QCM trop trivial / au distracteur trop faible si l'étudiant a jugé ce type « trop facile ».` : null,
    ``,
    blind,
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON conforme.`,
    JSON.stringify(VERIFY_SCHEMA, null, 2),
  ].filter((l) => l != null).join("\n");
  step("Vérification à l'aveugle des QCM (résolution indépendante, figures vues)…", 70);
  let res: { results: { index: number; correct: number[]; ok: boolean; issue?: string }[] };
  try { res = extractJson(await completeText({ prompt, model: "opus", timeoutMs: 420_000, addDirs: figDirs })); }
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
 *  `count`/`openCount` : la COMPOSITION choisie par Ben (composeur V9). `focus` : « Mets l'accent
 *  sur… » (générique) — garantit ~2 QCM sur le thème sans monopoliser (count ≤ 2 → entièrement ciblé). */
export async function generateQcmExam(opts: { count?: number; openCount?: number; focus?: string; onStep?: StepCb } = {}): Promise<QcmExamResult> {
  await ensureQcmSchema();
  const step = opts.onStep ?? (() => {});
  const fmt = await getFormatProfile();
  const focus = (opts.focus ?? "").trim() || undefined;
  const qcmShare = (fmt?.question_types ?? []).filter((t) => t.type === "scq" || t.type === "mcq").reduce((s, t) => s + (t.approx_count || 0), 0);
  // count peut être 0 (drill « 0 QCM + 1 ouvert ») → on respecte le choix explicite ; sinon défaut détecté.
  const count = Math.max(0, opts.count ?? Math.min(20, Math.max(8, qcmShare || 12)));
  const openCount = Math.max(0, opts.openCount ?? Math.min(3, Math.max(0, (fmt?.question_types ?? []).find((t) => t.type === "open")?.approx_count ?? 2)));
  if (count === 0 && openCount === 0) throw new Error("Composition vide : choisis au moins 1 QCM ou 1 question ouverte.");
  // « Mets l'accent sur… » (focus GÉNÉRIQUE, allégée) : garantit ~2 QCM sur le thème choisi SANS
  // monopoliser — le reste couvre le programme. Petit count (≤2) → entièrement ciblé (drill).
  // moteur-v2 (P2) : couverture LARGE (pickCoverage : tête + longue traîne) + MOULES échantillonnés
  // proportionnellement à l'ADN détecté du cours (sans ADN → null = comportement d'avant).
  const dna = await getExamDna().catch(() => null);
  const covAll = await coverageTopics();
  const nFocus = focus ? Math.min(2, Math.max(1, count)) : 0;
  const cov = pickCoverage(covAll, Math.max(1, count - nFocus));
  const qcmTopics: { label: string; method: string | null }[] = [];
  for (let i = 0; i < count; i++) {
    qcmTopics.push(i < nFocus ? { label: focus!, method: null } : cov[(i - nFocus) % cov.length]);
  }
  const qcmMolds = sampleMolds(dna, count);
  step(`Architecte : ${count} QCM + ${openCount} ouverte(s)${focus ? ` (accent : « ${focus} »)` : ""}${dna ? ` · moules ADN (${dna.molds.length})` : " au format détecté"}…`, 8);

  // lots de 4 QCM en parallèle borné (2 lots à la fois). RÉSILIENT : un lot qui échoue (JSON
  // malformé du modèle sur du math) est réessayé une fois puis IGNORÉ — il ne plante pas le job.
  const BATCH = 4;
  const batches: { topics: { label: string; method: string | null }[]; molds: (MoldKind | null)[] }[] = [];
  for (let i = 0; i < count; i += BATCH) {
    const topicsSlice: { label: string; method: string | null }[] = [];
    const moldsSlice: (MoldKind | null)[] = [];
    for (let k = 0; k < BATCH && i + k < count; k++) {
      topicsSlice.push(qcmTopics[(i + k) % qcmTopics.length]);
      moldsSlice.push(qcmMolds[i + k] ?? null);
    }
    batches.push({ topics: topicsSlice, molds: moldsSlice });
  }
  const safeBatch = async (bt: { topics: { label: string; method: string | null }[]; molds: (MoldKind | null)[] }): Promise<QcmItem[]> => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const items = await generateQcmBatch(bt.topics, bt.topics.length, step, undefined, undefined, { molds: bt.molds, dna });
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
  // moteur-v2 (P2/P3) : moules « ouverts » échantillonnés depuis l'ADN, imposés à l'architecte.
  const openQs: ExamQuestion[] = [];
  if (openCount > 0) {
    const { architectQuestion } = await import("@/lib/architect");
    const { profile } = require("@/lib/course-profile");
    const archs = profile().archetypes as any[];
    const openMolds = sampleMolds(dna, openCount, {
      only: ["proof_analysis", "derivation", "design", "applied_scenario", "formula_computation", "code_trace", "table_fill", "figure_reading"],
    });
    for (let i = 0; i < openCount; i++) {
      const t = cov[(count + i) % cov.length]; // ouvertes = couverture programme (le focus reste sur les QCM)
      const a = archs[i % archs.length];
      step(`Question ouverte ${i + 1}/${openCount} (architecte) — ${t.label}…`, 82 + i);
      try {
        const r = await architectQuestion(a, `${t.label}${t.method ? ` — ${t.method}` : ""}`, 15, { maxRounds: 1, mold: openMolds[i] ?? null, onStep: (m) => step(`Ouverte ${i + 1} · ${m}`, 82 + i) });
        openQs.push({ ...r.q, points: 15 });
      } catch (e) { step(`Question ouverte ${i + 1} ignorée : ${(e as Error).message.slice(0, 60)}`, 82 + i); }
    }
  }

  if (!all.length && !openQs.length) throw new Error("Rien n'a pu être généré (lots QCM et questions ouvertes échoués). Réessaie.");

  // persiste l'exam + les QCM + les ouvertes. Les figures rendues (PNG temporaires) prennent leur
  // nom DÉFINITIF qcm-<examId>-fig<idx>.png (dans examsDir, à côté du .tex compilé).
  const examId = await q.insert(`INSERT INTO exams (format_template, status) VALUES ('qcm','ready')`);
  for (let i = 0; i < all.length; i++) {
    const it = all[i];
    if (it.figureFile) {
      const finalName = `qcm-${examId}-fig${i}.png`;
      try {
        fs.renameSync(path.join(examsDir(), it.figureFile), path.join(examsDir(), finalName));
        it.figureFile = finalName;
      } catch { it.figureFile = null; it.figureSpec = null; } // figure perdue → item sans figure (honnête)
    }
  }
  await q.tx(async () => {
    for (let i = 0; i < all.length; i++) {
      const it = all[i];
      const figureJson = it.figureSpec ? JSON.stringify({ spec: it.figureSpec, file: it.figureFile, truth: it.figureTruth }) : null;
      await q.run(`INSERT INTO qcm_items (exam_id, idx, topic, type, stem, options_json, correct_json, misconceptions_json, explanation, verified, mold, figure_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, examId, i, it.topic, it.type, it.stem, JSON.stringify(it.options), JSON.stringify(it.correct), JSON.stringify(it.misconceptions), it.explanation, it.verified, it.mold ?? null, figureJson);
    }
    for (const oq of openQs) {
      await q.run(`INSERT INTO exam_questions (exam_id, concept, statement_html, solution_html, source_inspiration) VALUES (?,?,?,?,?)`, examId, oq.concept, oq.statement_tex, oq.solution_tex, "qcm-open");
    }
  });
  const verified = all.filter((it) => it.verified === 1).length;
  await q.run(`UPDATE exams SET verify_summary = ? WHERE id = ?`, `QCM ${all.length} (${verified} vér.) + ${openQs.length} ouverte(s)`, examId);

  // rendu PDF (énoncé + corrigé) au look d'un vrai final du cours
  step("Rendu du PDF (look vrai final)…", 92);
  let pdf: string | undefined, texError: string | undefined;
  try {
    const { buildQcmArtifact } = await import("@/lib/qcm-latex");
    const dateLabel = nowStr().slice(0, 10);
    const out = await buildQcmArtifact(examId, { items: all, open: openQs }, dateLabel);
    pdf = out.file; texError = out.texError;
    await q.run(`UPDATE exams SET html_path = ? WHERE id = ?`, out.file, examId);
  } catch (e) { texError = (e as Error).message; }

  step(`Examen QCM #${examId} prêt — ${all.length} QCM + ${openQs.length} ouverte(s) ✓`, 100);
  return { id: examId, count: all.length, verified, open: openQs.length, pdf, texError };
}

export type QcmOpenView = { id: number; concept: string; statement: string; solution: string };
export type QcmExamView = { id: number; createdAt: string; verifySummary: string | null; pdf: string | null; items: (Omit<QcmItem, "correct" | "misconceptions"> & { id: number; idx: number })[]; open: QcmOpenView[] };

/** Un examen QCM pour l'affichage (SANS les clés — l'auto-correction se fait via /api). */
export async function getQcmExam(examId: number, withKeys = false): Promise<QcmExamView | null> {
  await ensureQcmSchema();
  const e = await q.get<any>(`SELECT id, created_at, verify_summary, html_path FROM exams WHERE id = ? AND format_template = 'qcm'`, examId);
  if (!e) return null;
  const rows = await q.all<any>(`SELECT * FROM qcm_items WHERE exam_id = ? ORDER BY idx`, examId);
  let open: QcmOpenView[] = [];
  try {
    const { texToHtml } = require("@/lib/exam-latex");
    open = (await q.all<any>(`SELECT id, concept, statement_html, solution_html FROM exam_questions WHERE exam_id = ? AND source_inspiration = 'qcm-open' ORDER BY id`, examId))
      .map((r) => ({ id: r.id, concept: r.concept, statement: texToHtml(r.statement_html ?? ""), solution: withKeys ? texToHtml(r.solution_html ?? "") : "" }));
  } catch {}
  return {
    id: e.id, createdAt: e.created_at, verifySummary: e.verify_summary, pdf: e.html_path ?? null,
    items: rows.map((r) => {
      let figure: string | null = null;
      try { figure = r.figure_json ? (JSON.parse(r.figure_json).file ?? null) : null; } catch {}
      return {
        id: r.id, idx: r.idx, topic: r.topic, type: r.type, stem: r.stem,
        options: JSON.parse(r.options_json), explanation: withKeys ? r.explanation : "", verified: r.verified,
        mold: r.mold ?? null, figureFile: figure,
        ...(withKeys ? { correct: JSON.parse(r.correct_json), misconceptions: JSON.parse(r.misconceptions_json) } : {}),
      };
    }) as any,
    open,
  };
}

/** Corrige des réponses {idx: number[]} contre la clé connue → score + détail (Pilier E). */
export async function gradeQcm(examId: number, answers: Record<number, number[]>): Promise<{ score: number; total: number; detail: { idx: number; correct: number[]; chosen: number[]; ok: boolean; explanation: string; misconceptions: string[] }[] }> {
  await ensureQcmSchema();
  const rows = await q.all<any>(`SELECT idx, correct_json, explanation, misconceptions_json FROM qcm_items WHERE exam_id = ? ORDER BY idx`, examId);
  const detail = rows.map((r) => {
    const correct: number[] = JSON.parse(r.correct_json);
    const chosen = (answers[r.idx] ?? []).slice().sort();
    const ok = JSON.stringify(correct.slice().sort()) === JSON.stringify(chosen);
    return { idx: r.idx, correct, chosen, ok, explanation: r.explanation, misconceptions: JSON.parse(r.misconceptions_json) };
  });
  return { score: detail.filter((d) => d.ok).length, total: rows.length, detail };
}
