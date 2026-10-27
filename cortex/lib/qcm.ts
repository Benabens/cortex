import { currentCourse } from "@/db/client";
import { q, nowStr } from "@/db/q";
import { completeText, extractJson } from "@/lib/llm";
import { examLanguageFor, readStoredProfile, resolveExamFormat } from "@/lib/exam-format";
import { languageName } from "@/lib/profiles/generic-directives";
import { DATA_RULE, dataBlock } from "@/lib/prompt-safety";
import { courseRefImages } from "@/lib/course-vision";
import type { ExamQuestion, StepCb } from "@/lib/exam";
import { getFormatProfile } from "@/lib/format";
import { calibrationBlock } from "@/lib/calibration";
import { getExamDna, sampleMolds, pickCoverage, fewShotForMold, type ExamDna } from "@/lib/exam-dna";
import { MOLD_DEFS, normalizeMold, type MoldKind } from "@/lib/molds";
import { renderFigure, figureSpecPromptBlock, type FigureSpec } from "@/lib/figure-gen";
import { examsDir } from "@/lib/paths";
import type { Archetype } from "@/lib/archetypes";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * ARCHITECTE QCM (générique). Génère des QCM de haut niveau au format détecté :
 *  - chaque distracteur cible une IDÉE FAUSSE précise (pas du remplissage) ;
 *  - exactement UNE bonne réponse (SCQ) ou le sous-ensemble correct (MCQ), VÉRIFIÉ À L'AVEUGLE ;
 *  - ZÉRO indice qui trahit (option correcte ni plus longue ni plus détaillée, pas de « toutes les
 *    réponses ci-dessus », cohérence grammaticale, pas de distracteur absurde) ;
 *  - teste la COMPRÉHENSION, pas le par-cœur.
 *
 * Persisté dans `qcm_items` (par exam). La correction est instantanée (clé connue).
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
  // MOULE de la question (échantillonné depuis l'ADN détecté) + figure éventuelle
  // (spec générique rendue en PNG sandboxé ; truth = valeurs que la figure fixe, pour la vérif).
  mold?: MoldKind | null;
  figureSpec?: FigureSpec | null;
  figureFile?: string | null;
  figureTruth?: Record<string, number> | null;
  /** Fait du cours que la question teste (conception), non persisté. */
  sourceFact?: string | null;
  /** Verdict du juge à l'aveugle : pouvoir discriminant (1-5), réussite avec les seuls noms des notions. */
  discrimination?: number | null;
  nameOnly?: boolean | null;
  judgeIssue?: string | null;
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
          options: { type: "array", items: { type: "string" }, description: "4 à 5 options : des PROPOSITIONS COMPLÈTES de longueurs COMPARABLES, pas d'« toutes les réponses ci-dessus »." },
          correct: { type: "array", items: { type: "integer" }, description: "Indices 0-based de la/des bonne(s) réponse(s). Exactement 1 pour scq." },
          misconceptions: { type: "array", items: { type: "string" }, description: "Pour CHAQUE option : « [procédé] idée fausse précise » que ce distracteur punit (procédé de la taxonomie) ; chaîne vide pour les bonnes réponses." },
          source_fact: { type: "string", description: "Le fait PRÉCIS du cours que la question teste (étude et chiffre, condition d'une définition, mécanisme), tel qu'il apparaît dans les extraits." },
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
  // moule + figure (spec/fichier/truth) par item, additif.
  await q.ensureColumns("qcm_items", ["mold", "figure_json"]);
}

/** Sujets à couvrir : blueprint (topics pondérés) si dispo, sinon archétypes du cours.
 *  Retourne TOUTE la liste ordonnée par poids (plus de LIMIT 14 : la LARGEUR
 *  est gérée à l'échantillonnage par pickCoverage, qui inclut la longue traîne). */
async function coverageTopics(): Promise<{ label: string; method: string | null }[]> {
  try {
    const rows = await q.all<{ label: string; method: string | null }>(`SELECT label, method FROM topics ORDER BY exam_weight DESC, exam_count DESC, label`);
    if (rows.length) return rows;
  } catch {}
  // Pas encore de notions analysées : les titres des supports du cours, plutôt que des archétypes
  // génériques qui ne parlent d'aucune notion (cas d'un cours sans annale fraîchement préparé).
  try {
    const titles = await q.all<{ title: string }>(
      `SELECT DISTINCT s.title FROM sources s WHERE s.type NOT IN ('final','midterm','sample_questions','exam_info') ORDER BY s.recency_weight DESC, s.id`,
    );
    if (titles.length) return titles.map((t) => ({ label: t.title, method: null }));
  } catch {}
  // Import paresseux : course-profile charge les profils qui dépendent du moteur d'examen.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { profile } = require("@/lib/course-profile") as typeof import("@/lib/course-profile");
  return profile().archetypes.map((a) => ({ label: a.concept, method: a.structure }));
}

/**
 * TAXONOMIE DES DISTRACTEURS — ce qui sépare un QCM d'examen d'un QCM de remplissage
 * (cas HUM-285 : options d'un mot, mauvaises réponses évidentes). Chaque distracteur
 * porte son procédé entre crochets dans « misconceptions ».
 */
const DISTRACTOR_TAXONOMY = [
  `TAXONOMIE DES DISTRACTEURS — chaque mauvaise option est construite par UN de ces procédés (écris-le entre crochets en tête de son "misconceptions", ex. « [inversion] … ») :`,
  `  · [inversion] le résultat ou le sens d'un effet est inversé (augmente ↔ diminue, plus ↔ moins, cause ↔ conséquence) ;`,
  `  · [mauvaise condition] la bonne notion, mais une condition de sa définition change ou manque (même mesure, une seule condition diffère) ;`,
  `  · [mauvaise attribution] le bon chiffre ou le bon résultat attribué à la mauvaise étude, au mauvais auteur, pays, année ou acteur ;`,
  `  · [sur-généralisation] un résultat vrai sous conditions présenté comme universel (« toujours », « dans tous les cas », « suffit à ») ;`,
  `  · [quasi-synonyme] une notion voisine du cours, confondue avec la bonne (même famille, autre définition) ;`,
  `  · [calcul] (matières quantitatives) l'erreur de calcul ou de méthode typique — jamais une valeur au hasard.`,
];

const OPTION_RULES = [
  `  - OPTIONS = PROPOSITIONS COMPLÈTES : chaque option est une phrase autonome qui affirme quelque chose de vérifiable — jamais un mot isolé ni un simple nom de notion ; longueurs comparables (±30 %), même structure grammaticale ; toutes plausibles pour un étudiant qui n'a retenu que les noms des notions.`,
  `  - TIGES INDÉPENDANTES : chaque question se comprend seule, sans scénario partagé avec une autre question, et ne donne pas la réponse d'une autre.`,
  `  - ANCRAGE : chaque question teste un FAIT PRÉCIS des extraits du cours fournis (résultat d'étude avec auteurs et chiffres, condition d'une définition, mécanisme) ; recopie ce fait dans "source_fact". Rien hors des extraits et du programme.`,
];

const NO_CLASSIFICATION =
  `  - INTERDIT : les questions « classe ce cas dans la notion X » / « quel concept illustre cette situation ? » dont les options sont des noms de notions — elles se réussissent sans comprendre. Teste plutôt les CONDITIONS qui font qu'un cas relève ou non d'une notion (même mesure, une condition change).`;

/** Types de sources jamais pris comme « faits du cours » à tester (annales : on n'en recopie pas les questions). */
const NOT_COURSE_FACTS = new Set(["final", "midterm", "sample_questions", "exam_info"]);

/** Fenêtre d'un texte autour du premier mot de la requête qu'il contient. */
function windowAround(text: string, query: string, cap: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= cap) return t;
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
  const lower = t.toLowerCase();
  const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, Math.min(at - Math.floor(cap / 3), t.length - cap));
  return t.slice(start, start + cap);
}

/** Extraits du cours sur les sujets d'un lot (recherche plein texte), pour ancrer chaque question sur un fait précis. */
export async function coursePassages(topics: string[], perTopic = 2, cap = 900): Promise<{ src: string; text: string }[]> {
  const { search } = await import("@/lib/search");
  const out: { src: string; text: string }[] = [];
  const seen = new Set<number>();
  for (const topic of topics) {
    let groups: Awaited<ReturnType<typeof search>> = [];
    try { groups = await search(topic, 16, "or"); } catch { continue; }
    let k = 0;
    for (const h of groups.flatMap((g) => g.hits)) {
      if (k >= perTopic) break;
      if (NOT_COURSE_FACTS.has(h.sourceType) || seen.has(h.itemId)) continue;
      seen.add(h.itemId);
      const row = await q.get<{ text: string }>(`SELECT text FROM items WHERE id = ?`, h.itemId);
      if (!row?.text) continue;
      out.push({ src: h.sourceTitle, text: windowAround(row.text, topic, cap) });
      k++;
    }
  }
  return out;
}

/** Questions d'exemple officielles (sans annale) : citées par la détection du format, et sources « exemples ». */
export async function officialExamples(max = 3, cap = 700): Promise<{ src: string; text: string }[]> {
  const out: { src: string; text: string }[] = [];
  const stored = await readStoredProfile();
  for (const e of stored?.examples ?? []) out.push({ src: "exemple officiel", text: e.slice(0, cap) });
  try {
    const rows = await q.all<{ src: string; text: string }>(
      `SELECT s.title src, i.text text FROM items i JOIN sources s ON s.id = i.source_id WHERE s.type = 'sample_questions' ORDER BY s.id, i.id LIMIT ?`, max,
    );
    for (const r of rows) out.push({ src: r.src, text: r.text.slice(0, cap) });
  } catch {}
  return out.slice(0, max);
}

/** true si la bonne option se repère à sa longueur (nettement plus longue que les distracteurs). */
export function qcmLengthCue(options: string[], correct: number[]): boolean {
  if (correct.length !== 1 || options.length < 3) return false;
  const len = (s: string) => s.trim().length;
  const right = len(options[correct[0]] ?? "");
  const others = options.filter((_, i) => i !== correct[0]).map(len).sort((a, b) => a - b);
  const median = others[Math.floor(others.length / 2)];
  return right > 1.5 * median && right - median > 25;
}

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Mélange les options d'un QCM (graine déterministe) en gardant la clé et les idées
 * fausses alignées : un modèle place volontiers la bonne réponse en B ou C.
 */
export function shuffleQcmOptions<T extends { options: string[]; correct: number[]; misconceptions: string[] }>(it: T, seed: number): T {
  const order = it.options.map((_, i) => i);
  const r = rng(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const where = new Map(order.map((from, to) => [from, to]));
  return {
    ...it,
    options: order.map((from) => it.options[from]),
    misconceptions: order.map((from) => it.misconceptions?.[from] ?? ""),
    correct: it.correct.map((k) => where.get(k) ?? k).sort((a, b) => a - b),
  };
}

const seedOf = (s: string) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);

/** Pourquoi un QCM vérifié est trop faible pour être gardé tel quel, ou null. */
function weaknessOf(it: QcmItem): string | null {
  const issue = it.judgeIssue ? ` (${it.judgeIssue})` : "";
  if (it.nameOnly) return `réussie avec les seuls noms des notions ou par élimination${issue}`;
  if (typeof it.discrimination === "number" && it.discrimination <= 2) return `pouvoir discriminant faible (${it.discrimination}/5)${issue}`;
  if (qcmLengthCue(it.options, it.correct)) return "la bonne option se repère à sa longueur";
  return null;
}

/** Étiquette d'un sujet imposé par le focus de l'étudiant : un thème, pas une forme. */
const FOCUS_METHOD = "accent thématique demandé par l'étudiant : un thème, ignore toute indication de forme ou de nombre";

const ARCHITECT_QCM_RULES = [
  `RÈGLES D'ARCHITECTE QCM (impératives) :`,
  `  - Chaque DISTRACTEUR cible une IDÉE FAUSSE réelle et précise (une mauvaise intuition courante), JAMAIS du remplissage ni de l'absurde.`,
  `  - SCQ : EXACTEMENT une bonne réponse. MCQ : le sous-ensemble correct (≥1), selon la convention du format.`,
  `  - AUCUN indice qui trahit : la bonne option n'est ni plus longue ni plus détaillée ; pas de « toutes les réponses ci-dessus » ; cohérence grammaticale stem↔options ; options de longueur comparable ; pas de négations piégeuses gratuites.`,
  `  - Teste la COMPRÉHENSION / le raisonnement, pas la récitation d'une définition.`,
  `  - Calibre la difficulté sur les VRAIS examens du cours (regarde les pages fournies).`,
];

/** Génère un LOT de QCM (1 appel LLM) couvrant des sujets donnés, au format du cours.
 *  `guidance` (optionnel, additif) : consignes supplémentaires injectées dans le prompt — sert au
 *  parcours de révision pour (a) bâtir des distracteurs sur les ERREURS RÉELLES de l'étudiant et
 *  (b) lister les énoncés déjà couverts à NE PAS répéter. Absent → comportement identique à avant.
 *  `opts.molds` (aligné aux topics) impose le MOULE de chaque question (ADN détecté) ;
 *  `opts.dna` active les figures (data-driven : seulement si le cours en a) + le cadrage appliqué. */
export async function generateQcmBatch(
  topics: { label: string; method: string | null }[],
  n: number,
  step: StepCb,
  focus?: string,
  guidance?: string,
  opts: {
    molds?: (MoldKind | null)[];
    dna?: ExamDna | null;
    /** Extraits du cours à tester (ancrage) ; absents → cherchés sur les sujets du lot. */
    passages?: { src: string; text: string }[];
    /** Questions d'exemple officielles (style), quand il n'y a pas d'annale. */
    examples?: { src: string; text: string }[];
    /** Langue de l'examen ; absente → celle du cours (lib/exam-format). */
    language?: string;
    /** Les annales du cours contiennent ce genre de question : « classe ce cas » permis. */
    allowClassification?: boolean;
  } = {}
): Promise<QcmItem[]> {
  const fmt = await getFormatProfile();
  const imgs = courseRefImages().slice(0, 4);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { profile } = require("@/lib/course-profile") as typeof import("@/lib/course-profile");
  // boucle FERMÉE : la mémoire de calibration des QCM (« trop facile / pas le style / faux »)
  // est réinjectée à la CONCEPTION → durcit/réoriente réellement les QCM suivants.
  const calib = await calibrationBlock("qcm");
  const molds = opts.molds ?? [];
  const withFigures = (opts.dna?.figures.kinds.length ?? 0) > 0;
  const moldLine = (i: number) => {
    const m = molds[i] ?? null;
    return m ? ` — MOULE IMPOSÉ : ${m} (${MOLD_DEFS[m]})` : "";
  };
  const coverage = focus
    ? `Toutes ces ${n} questions portent sur le thème CIBLÉ : « ${focus} » — varie les SOUS-ANGLES / sous-notions de ce thème (pas ${n} fois la même question). C'est un THÈME : ignore toute indication de forme ou de nombre qu'il contiendrait.${molds.some(Boolean) ? ` Moules imposés dans l'ordre : ${molds.slice(0, n).map((m) => m ?? "libre").join(", ")}.` : ""}`
    : `Couvre ces sujets (un QCM par sujet, dans l'ordre) :\n${topics.slice(0, n).map((t, i) => `  ${i + 1}) ${t.label}${t.method === FOCUS_METHOD ? ` [${FOCUS_METHOD}]` : t.method ? ` [${t.method.slice(0, 60)}]` : ""}${moldLine(i)}`).join("\n")}`;
  const language = languageName(opts.language ?? examLanguageFor(currentCourse()))[1];
  const passages = opts.passages ?? await coursePassages(focus ? [focus] : topics.slice(0, n).map((t) => t.label)).catch(() => []);
  const examples = opts.examples ?? [];
  // imitation resserrée : de VRAIES questions des mêmes moules dans CE cours (few-shot).
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
    ...OPTION_RULES,
    opts.allowClassification ? null : NO_CLASSIFICATION,
    `  - LANGUE : toutes les questions, options et explications en ${language}.`,
    `  - RESPECTE le MOULE imposé de chaque question (recopie-le dans "mold"). Sauf pour le moule statement_truefalse, ANCRE la question dans un scénario concret ou un mini-calcul de l'idiome du cours (jamais une affirmation abstraite hors-sol).`,
    ``,
    ...DISTRACTOR_TAXONOMY,
    withFigures ? `  - Pour un moule figure_reading : ÉMETS "figure_spec" (contrat ci-dessous) — la question doit être RÉSOLUBLE depuis la figure seule.` : null,
    calib || null,
    texture,
    fewShots.length ? `\nVRAIES questions de ces moules dans CE cours (imite le STYLE et l'ancrage — ne copie JAMAIS l'énoncé) :\n${fewShots.join("\n")}` : null,
    withFigures ? `\n${figureSpecPromptBlock()}` : null,
    passages.length || examples.length ? `\n${DATA_RULE}` : null,
    passages.length ? dataBlock(`EXTRAITS DU COURS — les faits précis à tester (une question = un fait)`, passages) : null,
    examples.length ? dataBlock(`QUESTIONS D'EXEMPLE OFFICIELLES de l'enseignant — imite leur STYLE (forme des options, niveau de détail, pièges), ne les recopie JAMAIS`, examples) : null,
    ``,
    coverage,
    guidance ? `\n${guidance}` : null,
    `Réponds UNIQUEMENT avec l'objet JSON { "items": [ … ] } (${n} QCM). Aucun fichier.`,
    JSON.stringify(QCM_BATCH_SCHEMA, null, 2),
  ].filter((l) => l != null && l !== "").join("\n");
  step(`Génération de ${n} QCM (architecte · moules + idées fausses)…`, 30);
  const r = extractJson<{ items: (QcmItem & { figure_spec?: FigureSpec })[] }>(await completeText({ prompt, model: "opus", timeoutMs: 480_000 }));
  const items: QcmItem[] = [];
  for (let i = 0; i < (r.items ?? []).length; i++) {
    const raw = r.items[i];
    const imposed = molds[i] ?? null;
    const fact = (raw as { source_fact?: unknown }).source_fact;
    const base: QcmItem = {
      ...raw,
      misconceptions: Array.isArray(raw.misconceptions) ? raw.misconceptions : [],
      verified: null,
      mold: normalizeMold(raw.mold) ?? imposed,
      figureSpec: null,
      figureFile: null,
      figureTruth: null,
      sourceFact: typeof fact === "string" ? fact : null,
    };
    delete (base as { source_fact?: unknown }).source_fact;
    // Position de la bonne réponse mélangée (graine = l'énoncé : reproductible), jamais pour une question à figure.
    const it = Array.isArray(base.options) && Array.isArray(base.correct) && !(raw as { figure_spec?: unknown }).figure_spec
      ? shuffleQcmOptions(base, seedOf(base.stem ?? ""))
      : base;
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
          issue: { type: "string", description: "Court : ce qui cloche (clé fausse, 2 réponses défendables, indice qui trahit, distracteur absurde, réussie sans connaître le cours). Vide si ok." },
          discrimination: { type: "integer", description: "Pouvoir discriminant, 1 à 5 : 1 = un étudiant qui ne connaît que les NOMS des notions (ni leurs conditions, ni les résultats des études) la réussit ; 5 = seul un étudiant qui maîtrise le détail du cours la réussit." },
          name_only: { type: "boolean", description: "true si elle se réussit avec les seuls noms des notions, ou en éliminant des options absurdes." },
        },
        required: ["index", "correct", "ok", "discrimination", "name_only"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

/** Vérif à l'aveugle d'un lot de QCM : résous chaque QCM SANS la clé, confirme/corrige la clé.
 *  Les questions à FIGURE sont re-résolues DEPUIS la figure (vision : le solveur
 *  ouvre le PNG rendu) ; sans quoi une question de lecture de figure serait jugée au hasard. */
export async function verifyQcmBatch(items: QcmItem[], step: StepCb): Promise<QcmItem[]> {
  const blind = items.map((q, i) =>
    `Q${i}. [${q.type}]${q.figureFile ? ` [FIGURE : ouvre ${path.join(path.relative(process.cwd(), examsDir()), q.figureFile)} avec l'outil Read]` : ""} ${q.stem}\n${q.options.map((o, k) => `   (${k}) ${o}`).join("\n")}`
  ).join("\n\n");
  const figDirs = items.some((q) => q.figureFile) ? [examsDir()] : [];
  // la mémoire de calibration des QCM est aussi réinjectée à la CRITIQUE : un « trop facile »
  // passé rend la vérif plus sévère sur la trivialité/les indices qui trahissent.
  const calib = await calibrationBlock("qcm");
  const prompt = [
    `Tu es un correcteur rigoureux du cours. Pour CHAQUE QCM ci-dessous, RÉSOUS-LE toi-même de zéro (sans clé fournie) et donne la/les bonne(s) réponse(s) par INDEX.`,
    `Signale si : la question est ambiguë (2 réponses défendables), un distracteur est absurde, ou un indice trahit la bonne réponse (longueur, « toutes les réponses », grammaire).`,
    `Note aussi son POUVOIR DISCRIMINANT (discrimination, 1 à 5) : mets-toi à la place d'un étudiant qui ne connaît que les noms des notions du cours — pas leurs conditions, pas les résultats des études. S'il la réussit (ou élimine assez d'options pour la deviner), discrimination ≤ 2 et name_only = true.`,
    figDirs.length ? `Certaines questions ont une FIGURE : OUVRE le PNG indiqué (outil Read) et résous DEPUIS la figure. Si la figure ne suffit pas à répondre, mets ok=false avec issue="figure insuffisante".` : null,
    calib ? `${calib}\nÀ la lumière de ces leçons, sois SÉVÈRE : signale aussi (issue) tout QCM trop trivial / au distracteur trop faible si l'étudiant a jugé ce type « trop facile ».` : null,
    ``,
    blind,
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON conforme.`,
    JSON.stringify(VERIFY_SCHEMA, null, 2),
  ].filter((l) => l != null).join("\n");
  step("Vérification à l'aveugle des QCM (résolution indépendante, figures vues)…", 70);
  let res: { results: { index: number; correct: number[]; ok: boolean; issue?: string; discrimination?: number; name_only?: boolean }[] };
  try { res = extractJson(await completeText({ prompt, model: "opus", timeoutMs: 420_000, addDirs: figDirs })); }
  catch { return items; } // fallback honnête : non vérifiés
  for (const r of res.results ?? []) {
    const q = items[r.index];
    if (!q) continue;
    q.discrimination = Number.isInteger(r.discrimination) ? Math.max(1, Math.min(5, r.discrimination!)) : null;
    q.nameOnly = typeof r.name_only === "boolean" ? r.name_only : null;
    q.judgeIssue = r.issue?.trim() ? r.issue.trim().slice(0, 240) : null;
    const keyMatch = JSON.stringify([...(q.correct ?? [])].sort()) === JSON.stringify([...(r.correct ?? [])].sort());
    if (r.ok && keyMatch) q.verified = 1;
    else if (r.correct?.length) { q.correct = r.correct; q.verified = 1; q.explanation = (q.explanation ? q.explanation + " " : "") + (r.issue ? `[clé corrigée à la vérif : ${r.issue}]` : "[clé alignée sur la résolution indépendante]"); }
    else q.verified = 0;
  }
  return items;
}

export type QcmExamResult = { id: number; count: number; verified: number; open: number; pdf?: string; texError?: string };

/** Génère un examen QCM complet (N QCM + M ouvertes), vérifié, persisté, rendu en PDF.
 *  `count`/`openCount` : la COMPOSITION choisie par l'utilisateur (composeur). `focus` : « Mets l'accent
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
  // « Mets l'accent sur… » (focus générique) : garantit ~2 QCM sur le thème choisi SANS
  // monopoliser — le reste couvre le programme. Petit count (≤2) → entièrement ciblé (drill).
  // couverture LARGE (pickCoverage : tête + longue traîne) + MOULES échantillonnés
  // proportionnellement à l'ADN détecté du cours (sans ADN → null = comportement d'avant).
  const dna = await getExamDna().catch(() => null);
  const covAll = await coverageTopics();
  const nFocus = focus ? Math.min(2, Math.max(1, count)) : 0;
  const cov = pickCoverage(covAll, Math.max(1, count - nFocus));
  const qcmTopics: { label: string; method: string | null }[] = [];
  for (let i = 0; i < count; i++) {
    qcmTopics.push(i < nFocus ? { label: focus!, method: FOCUS_METHOD } : cov[(i - nFocus) % cov.length]);
  }
  const qcmMolds = sampleMolds(dna, count);
  // Format résolu : langue de l'examen ; sans annale, les exemples officiels donnent le style,
  // et les questions « classe ce cas » restent interdites (permises si les annales en ont le style).
  const format = await resolveExamFormat().catch(() => null);
  const withAnnales = format?.basis === "annales";
  const shared = {
    dna,
    language: format?.language,
    allowClassification: withAnnales,
    examples: withAnnales ? [] : await officialExamples().catch(() => []),
  };
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
  /**
   * Un lot vérifié à l'aveugle ; ses items FAIBLES (réussis avec les seuls noms des notions,
   * peu discriminants, ou trahis par leur longueur) sont régénérés UNE fois, critique à l'appui,
   * et remplacés si la nouvelle version est meilleure.
   */
  const strengthen = async (bt: { topics: { label: string; method: string | null }[]; molds: (MoldKind | null)[] }, items: QcmItem[]): Promise<QcmItem[]> => {
    const weak = items.map((it, i) => ({ it, i, why: weaknessOf(it) })).filter((w): w is { it: QcmItem; i: number; why: string } => !!w.why);
    if (!weak.length) return items;
    step(`${weak.length} QCM trop faible(s) → régénération ciblée`, 0);
    const guidance = [
      `À CORRIGER — ces questions étaient trop faibles ; écris-en de NOUVELLES sur les mêmes sujets, sans ces défauts (options = propositions complètes, distracteurs de la taxonomie, fait précis du cours) :`,
      ...weak.map((w) => `  - « ${w.it.stem.slice(0, 160)} » : ${w.why}`),
    ].join("\n");
    try {
      const pick = <T,>(arr: T[]) => weak.map((w) => arr[w.i]);
      const again = await verifyQcmBatch(await generateQcmBatch(pick(bt.topics), weak.length, step, undefined, guidance, { ...shared, molds: pick(bt.molds) }), step);
      const out = items.slice();
      weak.forEach((w, k) => {
        const n = again[k];
        if (n && n.verified !== 0 && (!weaknessOf(n) || (n.discrimination ?? 0) > (w.it.discrimination ?? 0))) out[w.i] = n;
      });
      return out;
    } catch (e) {
      step(`Régénération ignorée (${(e as Error).message.slice(0, 50)}) — items d'origine gardés`, 0);
      return items;
    }
  };
  const safeBatch = async (bt: { topics: { label: string; method: string | null }[]; molds: (MoldKind | null)[] }): Promise<QcmItem[]> => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const items = await generateQcmBatch(bt.topics, bt.topics.length, step, undefined, undefined, { ...shared, molds: bt.molds });
        if (items.length) return await strengthen(bt, await verifyQcmBatch(items, step));
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

  // partie OUVERTE : chaque question via l'architecte (multi-passes + vérif), au niveau réel.
  // moules « ouverts » échantillonnés depuis l'ADN, imposés à l'architecte.
  const openQs: ExamQuestion[] = [];
  if (openCount > 0) {
    const { architectQuestion } = await import("@/lib/architect");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { profile } = require("@/lib/course-profile") as typeof import("@/lib/course-profile");
    const archs: Archetype[] = profile().archetypes;
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
type QcmExamRow = { id: number; created_at: string; verify_summary: string | null; html_path: string | null };
type QcmItemRow = {
  id: number; idx: number; topic: string; type: "scq" | "mcq"; stem: string;
  options_json: string; correct_json: string; misconceptions_json: string; explanation: string;
  verified: 0 | 1 | null; mold: MoldKind | null; figure_json: string | null;
};
type QcmOpenRow = { id: number; concept: string; statement_html: string | null; solution_html: string | null };

/** Un examen QCM pour l'affichage (SANS les clés — l'auto-correction se fait via /api). */
export async function getQcmExam(examId: number, withKeys = false): Promise<QcmExamView | null> {
  await ensureQcmSchema();
  const e = await q.get<QcmExamRow>(`SELECT id, created_at, verify_summary, html_path FROM exams WHERE id = ? AND format_template = 'qcm'`, examId);
  if (!e) return null;
  const rows = await q.all<QcmItemRow>(`SELECT * FROM qcm_items WHERE exam_id = ? ORDER BY idx`, examId);
  let open: QcmOpenView[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { texToHtml } = require("@/lib/exam-latex") as typeof import("@/lib/exam-latex");
    open = (await q.all<QcmOpenRow>(`SELECT id, concept, statement_html, solution_html FROM exam_questions WHERE exam_id = ? AND source_inspiration = 'qcm-open' ORDER BY id`, examId))
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
    }) as QcmExamView["items"],
    open,
  };
}

/** Note une réponse QCM sur 1. Un choix unique reste binaire ; un choix multiple pénalise les erreurs. */
export function scoreQcmAnswer(correctAnswer: number[], chosenAnswer: number[], optionCount: number): number {
  const correct = new Set(correctAnswer.filter((value) => Number.isInteger(value) && value >= 0 && value < optionCount));
  const chosen = new Set(chosenAnswer.filter((value) => Number.isInteger(value) && value >= 0 && value < optionCount));
  if (correct.size === 1) return chosen.size === 1 && chosen.has([...correct][0]) ? 1 : 0;
  if (correct.size === 0 || chosen.size === 0) return 0;
  const correctChosen = [...chosen].filter((value) => correct.has(value)).length;
  const wrongChosen = chosen.size - correctChosen;
  const wrongOptions = optionCount - correct.size;
  return Math.max(0, (correctChosen / correct.size) - (wrongOptions > 0 ? wrongChosen / wrongOptions : 0));
}

export type QcmGradeDetail = {
  idx: number;
  correct: number[];
  chosen: number[];
  ok: boolean;
  points: number;
  explanation: string;
  misconceptions: string[];
};

type QcmGradeRow = {
  idx: number;
  options_json: string;
  correct_json: string;
  explanation: string;
  misconceptions_json: string;
};

/** Corrige des réponses {idx: number[]} contre la clé connue → score + détail. */
export async function gradeQcm(examId: number, answers: Record<number, number[]>): Promise<{ score: number; total: number; detail: QcmGradeDetail[] }> {
  await ensureQcmSchema();
  const rows = await q.all<QcmGradeRow>(`SELECT idx, options_json, correct_json, explanation, misconceptions_json FROM qcm_items WHERE exam_id = ? ORDER BY idx`, examId);
  const detail = rows.map((r) => {
    const correct: number[] = JSON.parse(r.correct_json);
    const optionCount = (JSON.parse(r.options_json) as unknown[]).length;
    const chosen = [...new Set((answers[r.idx] ?? []).filter((value) => Number.isInteger(value) && value >= 0 && value < optionCount))].sort((a, b) => a - b);
    const ok = JSON.stringify(correct.slice().sort()) === JSON.stringify(chosen);
    const points = scoreQcmAnswer(correct, chosen, optionCount);
    return { idx: r.idx, correct, chosen, ok, points, explanation: r.explanation, misconceptions: JSON.parse(r.misconceptions_json) };
  });
  return { score: detail.reduce((sum, item) => sum + item.points, 0), total: rows.length, detail };
}
