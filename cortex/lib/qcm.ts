import { currentCourse } from "@/db/client";
import { q, nowStr } from "@/db/q";
import { HARD_STOP_CODES, LONG_OUTPUT_MAX_TOKENS, LlmError, completeJson, llmErrorCode, llmFailureReason } from "@/lib/llm";
import { DEFAULT_ANSWER_MODE, OPTIONS_MIN, QCM_DEFAULT, courseMaterialTitles, examLanguageFor, planMockExam, readStoredProfile, requestedFormat, resolveExamFormat, type AnswerMode } from "@/lib/exam-format";
import { languageName } from "@/lib/profiles/generic-directives";
import { DATA_RULE, dataBlock, sanitizeCorpus } from "@/lib/prompt-safety";
import { COURSE_MATTER_RULE, COURSE_TERMS_RULE, absentCourseNumbers, absentCourseTerms, corpusWindows, coursePassages, factNumbers, topicsInScope } from "@/lib/course-grounding";
import { rewriteExplanations, rewriteExplanationsOnOptions, secondLookOffCourse, verifierPassages, writeJustifications, type JustificationTarget, type OffCourseFlag } from "@/lib/qcm-evidence";
import { bestNotionMatch, capDrops, describeExplanationIssue, duplicateOptionIndices, explanationIssues, keyNotion, keyOnlyExplanation, keyProposition, notionBase, notionCap, notionMismatch, optionHead, sameProposition, sameSourceFact, withoutRemovedOptionRefs } from "@/lib/qcm-checks";
import { assignChapters, spreadOverChapters, variants } from "@/lib/coverage";
import { normalize, tokenize } from "@/lib/text";
import { courseRefImages } from "@/lib/course-vision";
import type { ExamQuestion, StepCb } from "@/lib/exam";
import { getFormatProfile } from "@/lib/format";
import { calibrationBlock } from "@/lib/calibration";
import { getExamDna, sampleMolds, pickCoverage, fewShotForMold, type ExamDna } from "@/lib/exam-dna";
import { MOLD_DEFS, normalizeMold, type MoldKind } from "@/lib/molds";
import { renderFigure, figureSpecPromptBlock, type FigureSpec } from "@/lib/figure-gen";
import { examsDir } from "@/lib/paths";
import type { Archetype } from "@/lib/archetypes";
import { PhaseProgress, phaseLine } from "@/lib/progress";
import { benchTrace } from "@/lib/bench/trace";
import { examSummaryLabel, qcmSummaryText } from "@/lib/exam-summary";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { storage } from "@/lib/storage";
import { untypesetChars } from "@/lib/tex-escape";
import { askedFacts, attributedFact, courseFacts, factDuplicates, planFacts, type CourseFact } from "@/lib/qcm-facts";
import { JUSTIFICATION_SCHEMA, assembleExplanation, distractorIndices, fillRationale, invalidateRationale, permuteRationale, rationaleCheck, rationaleFromModel, storedExplanation, structuredExplanationsEnabled, toStoredRationale, type QcmRationale } from "@/lib/qcm-rationale";
import { qcmCheckpointKey, readQcmCheckpoint, withFigurePresent, type QcmBatchState, type QcmCheckpoint, type QcmCheckpointStore, type QcmMissingState, type QcmPlan, type QcmReserveState } from "@/lib/qcm-checkpoint";

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

export { coursePassages } from "@/lib/course-grounding";

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
  /** Rang du sujet dans le lot demandé (non persisté) : un item écarté laisse SON sujet à combler. */
  slot?: number;
  /**
   * Raison de rejet relevée à la vérification (hors cours, définition différente du cours, hors
   * matière, clé contestée), non persistée : jamais gardé tel quel. Dans un examen, régénéré une
   * fois puis écarté et son sujet comblé ; dans la banque de révision, écarté.
   */
  rejected?: string | null;
  /** Le correcteur valide la question telle quelle (sa réponse est la clé, sans ambiguïté ni indice), non persisté. */
  judgeOk?: boolean | null;
  /** Question d'un sujet de l'accent demandé par l'étudiant (non persisté) : elle partage ce thème avec les autres. */
  focusSlot?: boolean;
  /** Options qu'on élimine sans connaître le cours (juge à l'aveugle) : régénéré, puis écarté. */
  trivialDistractors?: number[] | null;
  /** Options fausses qui répètent une autre option (même notion, même libellé), non persisté : remplacées. */
  duplicateOptions?: number[] | null;
  /** Notion du programme donnée à la conception (le sujet du lot), non persistée : plafond par notion. */
  notion?: string | null;
  /** Fait testable du cours (lib/qcm-facts) que la question teste : jamais deux questions d'un examen sur le même. Persisté. */
  factId?: string | null;
  /**
   * Notion du programme dont relève ce que la question teste (sa bonne réponse), nommée par la
   * revue finale (appel déjà fait), non persistée : recale l'étiquette d'une question dont le fait
   * a été rangé sous une autre notion à l'extraction (examen #16, Q8).
   */
  programmeNotion?: string | null;
  /**
   * Justification structurée (lib/qcm-rationale) : la clé, et une raison par option, rangée comme
   * `misconceptions`. Présente, `explanation` en est l'assemblage (syncExplanation), jamais un
   * paragraphe libre. Absente (QCM_STRUCTURED_EXPLANATIONS=0, réponse sans justification) :
   * l'explication texte et ses contrôles lexicaux, comme avant. Persistée (rationale_json).
   */
  rationale?: QcmRationale | null;
};

/**
 * Limites des appels du job QCM. Conception, vérification, audit final, remplacement de distracteurs
 * et doublons butaient sur 16 000 tokens (HUM-285, prod du 13 au 15/11) : réponse facturée, puis refaite ou
 * perdue. Le délai suit la sortie : 16 000 tokens sortaient en moins de 5 min, 32 000 tiennent en 10.
 */
const QCM_CALL_LIMITS = { maxTokens: LONG_OUTPUT_MAX_TOKENS, timeoutMs: 600_000 } as const;

/**
 * Vérification à l'aveugle : à l'effort par défaut, sa réflexion faisait 88 % de sa sortie (banc
 * HUM-285 du 15/11 : 40 k tokens pour 5,7 k de réponse). Effort moyen. La revue finale garde
 * l'effort par défaut : à effort moyen, elle signalait 5 à 9 doublons au lieu de 2, et la ronde de
 * comblement qui suivait coûtait plus que l'économie (boucle moteur, itération 3).
 */
const QCM_VERIFY_LIMITS = { ...QCM_CALL_LIMITS, effort: "medium" } as const;

/** Conception des lots : 83 % de réflexion dans sa sortie à l'effort par défaut (boucle moteur, itération 7). */
const QCM_DESIGN_LIMITS = { ...QCM_CALL_LIMITS, effort: "medium" } as const;

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
          source_fact: { type: "string", description: "Une citation courte, VERBATIM, recopiée mot pour mot depuis les EXTRAITS DU COURS et qui suffit à établir la bonne réponse." },
          explanation: { type: "string", description: "Pourquoi la bonne réponse est correcte ET pourquoi chaque distracteur est faux, en désignant chaque option par son CONTENU — jamais « option 2 », « B », « (c) » ni « la première » : l'ordre des options est mélangé après coup." },
          mold: { type: "string", description: "Recopie le MOULE imposé pour cette question (voir la consigne par question)." },
          figure_spec: { type: "object", description: "UNIQUEMENT si la question exige une figure data/plot (moule figure_reading) : le FIGURE SPEC JSON décrit dans le prompt. Sinon omets ce champ." },
        },
        required: ["topic", "type", "stem", "options", "correct", "misconceptions", "source_fact", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

/** Le type que le mode de réponse impose à chaque question (null : au choix, selon la convention du format). */
const IMPOSED_TYPE: Record<AnswerMode, "scq" | "mcq" | null> = { single: "scq", multiple: "mcq", mixed: null };

/**
 * Le schéma d'un lot pour un mode de réponse : le type imposé, s'il y en a un ; sans figure,
 * figure_spec (objet libre) est retiré, ce qui le rend exprimable en sortie structurée stricte.
 */
function batchSchema(mode: AnswerMode, withFigures: boolean, options: number | null, withFacts = false): object {
  const s = JSON.parse(JSON.stringify(QCM_BATCH_SCHEMA));
  const props = s.properties.items.items.properties;
  if (withFacts) {
    props.fact_id = { type: "string", description: "Recopie l'identifiant [f-…] du FAIT À TESTER imposé pour cette question." };
    s.properties.items.items.required.push("fact_id");
  }
  const imposed = IMPOSED_TYPE[mode];
  if (imposed) props.type = { type: "string", enum: [imposed], description: imposed === "scq" ? "scq : l'examen est à réponse unique." : "mcq : l'examen est à réponses multiples." };
  const expected = options ?? (imposed === "scq" ? SCQ_OPTIONS : null);
  if (expected) props.options = { ...props.options, minItems: expected, maxItems: expected, description: `EXACTEMENT ${expected} options${options ? ", comme dans les annales" : ""} : ${expected === 2 ? "les deux réponses d'un vrai/faux" : "des PROPOSITIONS COMPLÈTES de longueurs COMPARABLES"}, pas d'« toutes les réponses ci-dessus ».` };
  if (imposed === "scq") {
    props.correct.description = "Indice 0-based de LA bonne réponse : exactement un.";
  }
  if (!withFigures) delete props.figure_spec;
  // Justification structurée À LA PLACE du paragraphe libre (même appel, une sortie plus courte).
  if (structuredExplanationsEnabled()) {
    delete props.explanation;
    props.justification = JUSTIFICATION_SCHEMA;
    s.properties.items.items.required = s.properties.items.items.required.map((k: string) => (k === "explanation" ? "justification" : k));
  }
  return s;
}

/** Consigne du mode de réponse de l'examen (lib/exam-format) : le générateur la suit strictement. */
function answerModeRule(mode: AnswerMode): string {
  if (mode === "single") return `  - RÉPONSE UNIQUE : l'examen est à réponse unique. Chaque question est de type scq, avec EXACTEMENT une bonne réponse ; jamais de question à plusieurs bonnes réponses.`;
  const vary = `fais varier le nombre de bonnes réponses d'une question à l'autre (une régularité se devine)`;
  if (mode === "multiple") return `  - RÉPONSES MULTIPLES : l'examen est à réponses multiples. Chaque question est de type mcq : le sous-ensemble correct (une ou plusieurs bonnes réponses) ; ${vary}.`;
  return `  - SCQ : EXACTEMENT une bonne réponse. MCQ : le sous-ensemble correct (≥1), selon la convention du format ; pour les MCQ, ${vary}.`;
}

/**
 * Le type d'une question conçue, dans le mode de l'examen, ou null si elle n'y a pas sa place :
 * une question à plusieurs clés dans un examen à réponse unique est écartée (son sujet est comblé).
 */
function typeInMode(correct: number[], modelType: unknown, mode: AnswerMode): "scq" | "mcq" | null {
  const imposed = IMPOSED_TYPE[mode];
  if (imposed === "scq") return correct.length === 1 ? "scq" : null;
  return imposed ?? (correct.length > 1 || modelType === "mcq" ? "mcq" : "scq");
}

/**
 * Énoncés des examens précédents du cours : les MÊMES pour le concepteur (à ne pas reprendre) et pour
 * le contrôle des reprises. Job 26 : le concepteur en voyait 30, le contrôle en jugeait 60 ; une
 * question sur un fait de la seconde moitié, invisible au concepteur, était retirée comme reprise.
 */
const PREVIOUS_STEMS = 60;

/**
 * Options d'une question à réponse unique : exactement 4. Job 26 (15/11/2026) : une question à
 * 5 options (A-E) livrée dans un examen à réponse unique à 4 options — rien ne bornait le nombre
 * d'options d'une scq, ni à la conception ni à la porte de sortie.
 */
const SCQ_OPTIONS = 4;

/** Le nombre d'options convient-il à l'attente du format (à défaut, au moins deux) ? */
export function optionCountFits(n: number, expected: number | null | undefined): boolean {
  return expected ? n === expected : n >= OPTIONS_MIN;
}

/**
 * Distracteurs à remplacer, réduits à ceux qui peuvent l'être : un vrai/faux n'en a aucun, son
 * option fausse est la négation de la clé (la réécrire casserait la forme de l'annale).
 */
function replaceableDistractors(indices: number[], it: Pick<QcmItem, "options" | "correct">): number[] {
  if (it.options.length <= 2) return [];
  return [...new Set(indices.filter((k) => Number.isInteger(k) && k >= 0 && k < it.options.length && !(it.correct ?? []).includes(k)))];
}

/** Attente du format, avec quatre options par défaut pour une question à réponse unique. */
function expectedOptionCount(type: string | null | undefined, optionsPerQuestion: number | null | undefined): number | null {
  return optionsPerQuestion ?? (type === "scq" ? SCQ_OPTIONS : null);
}

/** Consigne du nombre d'options, quand l'annale le fixe. */
function optionCountRule(options: number): string {
  return `  - NOMBRE D'OPTIONS : EXACTEMENT ${options} options par question, comme dans les annales${options === 2 ? " (vrai/faux : une affirmation à juger, options « Vrai » et « Faux » dans la langue de l'examen)" : ""} ; jamais plus, jamais moins.`;
}

/** Un QCM exploitable : énoncé, au moins deux options texte, clé(s) valide(s). Sinon écarté (et comblé). */
function wellFormed(raw: unknown): boolean {
  const it = raw as Partial<QcmItem> | null;
  if (!it || typeof it.stem !== "string" || !it.stem.trim()) return false;
  if (!Array.isArray(it.options) || it.options.length < OPTIONS_MIN || !it.options.every((o) => typeof o === "string" && o.trim())) return false;
  const n = it.options.length;
  // Sans explication, la clé n'est pas justifiée dans le corrigé (banc du 04/11 : un lot entier sans).
  const key = (raw as { justification?: { key?: unknown } } | null)?.justification?.key;
  if ((typeof it.explanation !== "string" || !it.explanation.trim()) && !(structuredExplanationsEnabled() && typeof key === "string" && key.trim())) return false;
  return Array.isArray(it.correct) && it.correct.length > 0 && it.correct.every((k) => Number.isInteger(k) && k >= 0 && k < n);
}

async function ensureQcmSchema(): Promise<void> {
  // l'examen QCM s'insère dans `exams` (partagée) ; garantir la colonne verify_summary (les DB de
  // cours créées hors cs-202 ne l'ont pas — ensureExamCols n'a pas tourné). DDL canonique : db/tables.ts.
  await q.ensureTable("exams");
  await q.ensureColumns("exams", ["verify_summary"]);
  await q.ensureTable("exam_questions");
  await q.ensureTable("qcm_items");
  // moule + figure (spec/fichier/truth) par item, additif.
  await q.ensureColumns("qcm_items", ["mold", "figure_json", "fact_id", "rationale_json"]);
}

/** Sujets à couvrir : blueprint (topics pondérés) si dispo, sinon archétypes du cours.
 *  Retourne TOUTE la liste ordonnée par poids (plus de LIMIT 14 : la LARGEUR
 *  est gérée à l'échantillonnage par pickCoverage, qui inclut la longue traîne). */
export type CovTopic = { label: string; method: string | null; weight?: number; chapterId?: number | null };

export async function coverageTopics(): Promise<CovTopic[]> {
  const order = `ORDER BY exam_weight DESC, exam_count DESC, label`;
  try {
    // Poids et chapitre du plan : la répartition sur les chapitres en dépend (lib/coverage).
    const rows = await q.all<{ label: string; method: string | null; weight: number | null; chapterId: number | null }>(
      `SELECT label, method, exam_weight AS weight, plan_chapter_id AS "chapterId" FROM topics ${order}`,
    );
    // Matière seulement : une notion d'archive ou hors programme extraite avant la règle est écartée.
    const kept = await topicsInScope(rows);
    if (kept.length) return kept.map((r) => ({ label: r.label, method: r.method, weight: Number(r.weight ?? 0), chapterId: r.chapterId }));
  } catch {
    // Base sans la colonne du plan de cours (antérieure à course-plan) : poids et libellés seuls.
    try {
      const rows = await topicsInScope(await q.all<{ label: string; method: string | null; weight: number | null }>(`SELECT label, method, exam_weight AS weight FROM topics ${order}`));
      if (rows.length) return rows.map((r) => ({ label: r.label, method: r.method, weight: Number(r.weight ?? 0) }));
    } catch {}
  }
  // Pas encore de notions analysées : les titres des supports du cours, plutôt que des archétypes
  // génériques qui ne parlent d'aucune notion (cas d'un cours sans annale fraîchement préparé).
  const titles = await courseMaterialTitles();
  if (titles.length) return titles.map((label) => ({ label, method: null }));
  // Import paresseux : course-profile charge les profils qui dépendent du moteur d'examen.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { profile } = require("@/lib/course-profile") as typeof import("@/lib/course-profile");
  return profile().archetypes.map((a) => ({ label: a.concept, method: a.structure }));
}

/**
 * TAXONOMIE DES DISTRACTEURS — ce qui sépare un QCM d'examen d'un QCM de remplissage
 * (cas HUM-285 : options d'un mot, mauvaises réponses évidentes). Chaque distracteur
 * porte son procédé entre crochets dans « misconceptions ».
 *
 * Banc HUM-285 du 15/11 (it0 + it1, juge à l'aveugle) : une notion voisine réelle du cours
 * ([quasi-synonyme]) n'est triviale que 39 % du temps ; une restriction ajoutée à la bonne
 * réponse (« mais seulement… »), une inversion ou une sur-généralisation se réfutent par le
 * raisonnement 59 à 67 % du temps. Les quasi-synonymes passent donc en tête.
 */
const DISTRACTOR_TAXONOMY = [
  `TAXONOMIE DES DISTRACTEURS — chaque mauvaise option est construite par UN de ces procédés (écris-le entre crochets en tête de son "misconceptions", ex. « [quasi-synonyme] … ») :`,
  `  · [quasi-synonyme] PROCÉDÉ PRINCIPAL : une AUTRE notion, étude, technique ou acteur RÉELLEMENT présenté dans le cours, voisin de la bonne réponse (même famille), donné comme réponse à l'énoncé DANS SES TERMES : l'option reprend les données de l'énoncé (situation, critères, mots) autant que la bonne réponse et ne se trompe que sur la notion ou le détail que seul le cours distingue. Jamais une caractéristique de l'autre notion que l'énoncé contredit (une option qui décrit autre chose que ce que l'énoncé décrit se réfute en le relisant). Il paraît juste à qui ne connaît pas le cours, parce qu'il l'est ailleurs dans le cours ;`,
  `  · [mauvaise condition] la bonne notion, une condition de sa définition REMPLACÉE par une autre condition du cours (même place, même longueur) — jamais AJOUTÉE en restriction (« mais seulement », « uniquement si », « ne … que », « à condition que ») : la bonne réponse sans la réserve se repère sans le cours ;`,
  `  · [mauvaise attribution] le bon chiffre ou le bon résultat attribué à une AUTRE étude, un autre auteur, pays, année ou acteur que le cours cite aussi ;`,
  `  · [inversion] le sens d'un effet est inversé — seulement si ce sens ne se déduit ni du nom de la notion ni du bon sens (« le Système 1 est lent », « le RLHF se passe d'humains » se réfutent par les mots) ;`,
  `  · [sur-généralisation] un résultat vrai sous conditions, étendu à une condition voisine où il ne tient plus — SANS marqueur d'absolu (« toujours », « jamais », « suffit à », « quelles que soient », « dans tous les cas » trahissent le distracteur) ;`,
  `  · [calcul] (matières quantitatives) l'erreur de calcul ou de méthode typique — jamais une valeur au hasard.`,
  `  RÉPARTITION : dans une question conceptuelle (ni calcul ni code), au moins deux distracteurs sur trois sont des [quasi-synonyme] ; la bonne réponse n'est jamais la seule option sans réserve ni la plus nuancée.`,
];

/** Sans annale : rien ne dit la forme des options ; une proposition complète discrimine, un nom de notion non. */
const OPTIONS_WITHOUT_ANNALES =
  `  - OPTIONS = PROPOSITIONS COMPLÈTES : chaque option est une phrase autonome qui affirme quelque chose de vérifiable — jamais un mot isolé ni un simple nom de notion ; longueurs comparables (±30 %), même structure grammaticale ; toutes plausibles pour un étudiant qui n'a retenu que les noms des notions.`;

/**
 * Avec annales : leur forme fait foi. Imposer des phrases à un cours de calcul (CS-233)
 * allongeait les options et répétait la même phrase en tête de chacune : le juge à
 * l'aveugle préférait alors l'ancien examen (banc du 28/10/2026).
 */
const OPTIONS_WITH_ANNALES =
  `  - OPTIONS : même forme et même NOMBRE d'options que dans les annales du cours — une valeur ou une expression courte pour une question de calcul, une affirmation COMPLÈTE pour une question conceptuelle (jamais un nom de notion seul) ; longueurs comparables.`;

/** Consigne de l'explication : paragraphe libre (QCM_STRUCTURED_EXPLANATIONS=0) ou justification structurée. */
function explanationRule(): string {
  return structuredExplanationsEnabled()
    ? `  - JUSTIFICATION (structurée, pas de paragraphe) : "key" dit pourquoi la bonne réponse est juste, avec le fait du cours, sans parler des autres options ; "distractors" a EXACTEMENT une entrée par option fausse de TON tableau "options" — "option_index" son indice 0-based, "why_wrong" pourquoi CETTE option est fausse (le détail du cours qu'elle contredit). Jamais d'entrée pour une option absente du tableau, jamais deux pour la même ; dans chaque raison, aucune autre option, aucune lettre, aucun numéro ni rang : l'ordre des options est mélangé après coup, le corrigé est assemblé à partir de ces champs.`
    : `  - EXPLICATION : désigne les options par leur CONTENU, jamais par leur lettre, leur numéro ni leur rang (« la première », « la deuxième », « la dernière ») : l'ordre des options est mélangé après coup.`;
}

const OPTION_RULES = [
  // K — mock 4 de CS-290 : avec une consigne neutre, « erreur d'arrondi » ou « TypeError » comme
  // distracteurs ; le niveau ne doit jamais dépendre de la consigne de l'étudiant.
  `  - NIVEAU EXAMEN RÉEL, par défaut : distinctions fines entre notions proches du cours. Chaque distracteur est une notion, une définition, une valeur ou une sortie de code RÉELLEMENT présente dans le cours (ou une idée fausse documentée), légèrement déformée et proche de la bonne réponse — jamais une option générique ou hors sujet (« erreur d'arrondi », exception sans rapport comme « TypeError », « aucune de ces réponses ») qu'on élimine sans connaître le cours.`,
  `  - Aucune phrase commune répétée en tête de chaque option : factorise-la dans l'énoncé.`,
  `  - AUCUN distracteur réfutable par le bon sens ou par le sens des mots (définition évidente, contresens grossier, absolu) : chacun doit paraître juste à un étudiant qui connaît le thème mais pas le détail du cours ; même registre et même degré de nuance que la bonne réponse.`,
  `  - CALCUL : les mauvaises valeurs viennent d'une erreur plausible à une ÉTAPE INTERMÉDIAIRE (formule voisine du cours, mauvais dénominateur, agrégation ou condition omise) ; elles gardent le même type, les mêmes unités et le même ordre de grandeur que la clé. Elles ne sont jamais incompatibles avec leurs propres données et ne se réfutent pas par un calcul élémentaire déjà entièrement donné dans l'énoncé.`,
  `  - CODE : chaque mauvaise sortie correspond à une exécution plausible du code avec UNE confusion réellement enseignée (ordre des filtres, masque, index, agrégation, sous-chaîne) ; aucun distracteur n'est une exception arbitraire. La bonne réponse exige d'appliquer au moins une règle du cours, pas seulement de recopier ou d'exécuter mécaniquement le code affiché.`,
  `  - TIGES INDÉPENDANTES : chaque question se comprend seule, sans scénario partagé avec une autre question, et ne donne pas la réponse d'une autre.`,
  `  - ANCRAGE : chaque question teste un FAIT PRÉCIS des extraits du cours fournis (résultat d'étude avec auteurs et chiffres, condition d'une définition, mécanisme) ; "source_fact" est une CITATION courte, VERBATIM, recopiée MOT POUR MOT depuis ces extraits et suffit à établir la bonne réponse. La clé, son explication et les notions nommées par les distracteurs ne dépendent de RIEN hors de cette citation et des extraits.`,
  // Banc HUM-285 du 13/11 : 30 questions rejetées hors cours pour un détail ajouté (« cadre à quatre
  // capacités », « 14 % des tickets », « agrégation des paramètres »), vrai peut-être, absent du cours.
  `  - BORNÉ AUX EXTRAITS : la bonne réponse ET l'explication ne s'appuient que sur ce que les extraits écrivent. Aucun chiffre, auteur, exemple, mécanisme ou cadre ajouté de tes connaissances, même juste. Si un extrait développe peu une notion, teste ce qu'il dit (une définition, une distinction, un exemple, une condition) sans le compléter.`,
];

const NO_CLASSIFICATION =
  `  - INTERDIT : les questions « classe ce cas dans la notion X » / « quel concept illustre cette situation ? » dont les options sont des noms de notions — elles se réussissent sans comprendre. Teste plutôt les CONDITIONS qui font qu'un cas relève ou non d'une notion (même mesure, une condition change).`;

/** Avec annales : ce style de question n'est permis que si les vrais examens l'emploient. */
const CLASSIFICATION_IF_ANNALES =
  `  - Les questions « classe ce cas dans la notion X » (options = noms de notions) ne sont permises QUE si les vraies questions des annales du cours en contiennent ; sinon, teste les CONDITIONS qui font qu'un cas relève ou non d'une notion.`;

/**
 * Une option citée par sa lettre ou son numéro (« option 3 », « (C) », « B) »). Pas « l'option
 * d'interdire » ni l'article anglais « A ». Avec `optionCount`, un chiffre entre parenthèses ne
 * compte que s'il désigne une option existante : « le nombre de lignes (7) » d'un QCM à 4 options
 * n'en est pas une (banc du 04/11, CS-290 : question juste rejetée pour ce motif).
 */
function citesOptionLetter(text: string, optionCount?: number): boolean {
  const digitRef = [...text.matchAll(/\(([0-9])\)/g)].some((m) => optionCount === undefined || Number(m[1]) < optionCount);
  return /\b(?:[Oo]ptions?|[Rr]éponses?|[Cc]hoix|[Aa]nswers?|[Cc]hoices?|[Pp]ropositions?)\s*\(?(?:[A-Ha-h]|[0-9])\)?(?![\p{L}'’])/u.test(text)
    || /\([A-H]\)/.test(text) || digitRef
    || /(?:^|\s)[A-H]\)\s/.test(text);
}

const RANK_FR = "premi(?:er|ère)s?|deuxi[eè]mes?|seconde?s?|troisi[eè]mes?|quatri[eè]mes?|cinqui[eè]mes?|sixi[eè]mes?|(?:avant-)?derni(?:er|ère)s?|\\d+\\s*(?:re|er|ère|ème|eme|e)s?";
const NOUN_FR = "options?|réponses?|propositions?|affirmations?|choix|énoncés?";
/** Jugement porté sur une option (« est fausse », « sont justes ») : ce qui sépare un renvoi d'une tournure du cours (« le premier est l'ancrage »). */
const JUDGED_FR = "(?:est|sont|n['’]est|ne\\s+sont)\\s+(?:pas\\s+)?(?:fausses?|faux|justes?|correctes?|incorrectes?|exactes?|inexactes?|erronées?|vraies?|valides?|la\\s+bonne|les\\s+bonnes)";
const CRITIQUE_FR = "confond(?:ent)?|invers(?:e|ent)|attribu(?:e|ent)|exagèr(?:e|ent)|sur-généralis(?:e|ent)|oubli(?:e|ent)|prétend(?:ent)?|déform(?:e|ent)";
const RANK_EN = "first|second|third|fourth|fifth|sixth|last|penultimate|\\d+(?:st|nd|rd|th)";
const NOUN_EN = "options?|answers?|choices?|statements?|alternatives?|propositions?";
const JUDGED_EN = "(?:is|are|isn['’]t|aren['’]t)\\s+(?:not\\s+)?(?:correct|incorrect|wrong|right|false|true|valid|invalid)";
const CRITIQUE_EN = "confuses|reverses|inverts|attributes|misattributes|overstates|overgeneralizes";
const BEFORE = "(?:^|[^\\p{L}])";
/**
 * Rangs d'option : « la première option », « la troisième est fausse », « la bonne réponse est la
 * troisième », « the first and third options ». Pas les tournures du cours : « la première étude »,
 * « le premier est l'ancrage », « la première proposition de Thaler », « la première réponse qui
 * vient à l'esprit » (Système 1), « the choices one makes ».
 */
const RANK_PATTERNS = [
  new RegExp(`${BEFORE}(?:la|le|les|l['’])\\s*(?:deux\\s+|trois\\s+)?(?:${RANK_FR})\\s+(?:${NOUN_FR})(?![\\p{L}])(?!\\s+(?:de|du|des)\\s)(?!\\s+d['’])(?!\\s+qui\\s+(?:vien|surgi))(?!\\s+(?:spontanée|intuitive|instinctive|immédiate)s?)`, "iu"),
  new RegExp(`${BEFORE}(?:la|le|les|l['’])\\s*(?:${RANK_FR})\\s+(?:des|d['’]entre\\s+les)\\s+(?:${NOUN_FR})`, "iu"),
  new RegExp(`${BEFORE}(?:la|le|les)\\s+(?:deux\\s+|trois\\s+)?(?:${RANK_FR})\\s+(?:${JUDGED_FR}|${CRITIQUE_FR})(?![\\p{L}])`, "iu"),
  new RegExp(`${BEFORE}(?:est|sont)\\s+(?:la|le|les)\\s+(?:deux\\s+)?(?:${RANK_FR})\\s*(?:[.,;:)!]|$|\\s+et\\s)`, "iu"),
  new RegExp(`(?:^|[.;:!?]\\s+)(?:la|le|les)\\s+(?:deux\\s+)?(?:${RANK_FR})\\s*,[^.]{0,160}?${JUDGED_FR}`, "iu"),
  new RegExp(`${BEFORE}(?:${NOUN_FR})\\s*(?:n°|numéro)\\s*\\d`, "iu"),
  new RegExp(`${BEFORE}(?:options?|réponses?|propositions?)\\s+(?:une|deux|trois|quatre|cinq)(?:\\s+et|\\s*,|\\s+sont|\\s+est|[.;:]|$)`, "iu"),
  new RegExp(`\\bthe\\s+(?:two\\s+)?(?:${RANK_EN})(?:\\s*(?:,|and)\\s*(?:the\\s+)?(?:${RANK_EN}))*\\s+(?:${NOUN_EN})\\b`, "i"),
  new RegExp(`\\bthe\\s+(?:${RANK_EN})\\s+(?:one\\s+)?(?:${JUDGED_EN}|${CRITIQUE_EN})\\b`, "i"),
  new RegExp(`\\b(?:is|are)\\s+the\\s+(?:${RANK_EN})(?:\\s+one)?\\s*(?:[.,;:)!]|$)`, "i"),
  new RegExp(`\\b(?:options?|answers?|choices?)\\s+(?:one|two|three|four|five)(?:\\s+and|\\s*,|\\s+(?:is|are)\\b|[.;:]|$)`, "i"),
];

/** Une option désignée par son RANG (« la première option ») : le mélange des options le change. */
export function citesOptionRank(text: string): boolean {
  return RANK_PATTERNS.some((re) => re.test(text));
}

const ORD_FR: Record<string, number> = { premier: 0, "première": 0, premiere: 0, "deuxième": 1, deuxieme: 1, second: 1, seconde: 1, "troisième": 2, troisieme: 2, "quatrième": 3, quatrieme: 3, "cinquième": 4, cinquieme: 4, dernier: -1, "dernière": -1, derniere: -1 };
const ORD_EN: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, last: -1 };
const WRONG = /^(?:erronée|fausse|incorrecte|inexacte|wrong|incorrect|false)$/i;
const RIGHT = /^(?:correcte|juste|exacte|bonne|correct|right|true)$/i;

/**
 * Réécrit les renvois à une option par son RANG ou sa LETTRE (« la première proposition », « la
 * deuxième option fausse », « l'option C », « the second option ») en citant son contenu, dans
 * l'ordre d'avant le mélange. Banc moteur du 04/11/2026 : 4 explications sur 28 (synth-3p) en
 * avaient, chacune rejetée puis régénérée. null si un renvoi reste ambigu (« les deux premières »)
 * ou désigne une option absente : l'item suit alors le rejet habituel.
 */
export function repairOptionRefs(text: string, options: string[], correct: number[]): string | null {
  let bad = false;
  const at = (k: number) => (k >= 0 && k < options.length ? options[k] : (bad = true, null));
  const nth = (n: number, among: number[]) => (n === -1 ? among[among.length - 1] : among[n]) ?? -1;
  const all = options.map((_, i) => i);
  const wrong = all.filter((i) => !correct.includes(i));
  const pick = (n: number, qualifier?: string) => nth(n, qualifier && WRONG.test(qualifier) ? wrong : qualifier && RIGHT.test(qualifier) ? correct.slice().sort((a, b) => a - b) : all);
  const article = (noun: string, cap: boolean) => {
    const a = /^[aeéiou]/i.test(noun) ? "l'" : "la ";
    return cap ? a.charAt(0).toUpperCase() + a.slice(1) : a;
  };
  let out = text.replace(/\b(La|la|Le|le|L['’]|l['’])\s*(premi(?:er|ère|ere)|deuxi[eè]me|seconde?|troisi[eè]me|quatri[eè]me|cinqui[eè]me|derni(?:er|ère|ere))\s+(option|proposition|réponse|affirmation)(?:\s+(erronée|fausse|incorrecte|inexacte|correcte|juste|exacte|bonne))?(?![\p{L}])/gu,
    (_m, art: string, ord: string, noun: string, qual?: string) => {
      const o = at(pick(ORD_FR[ord.toLowerCase()] ?? 99, qual));
      if (o === null) return _m;
      return `${article(noun, /^[LA-Z]/.test(art))}${noun}${qual ? ` ${qual}` : ""} « ${o} »`;
    });
  out = out.replace(/\b(L['’]option|l['’]option|La réponse|la réponse|La proposition|la proposition)\s+\(?([A-H])\)?(?![\p{L}])/gu,
    (_m, head: string, letter: string) => {
      const o = at(letter.charCodeAt(0) - 65);
      return o === null ? _m : `${head} « ${o} »`;
    });
  out = out.replace(/\b(The|the)\s+(first|second|third|fourth|fifth|last)\s+(option|answer|choice|statement)\b/g,
    (_m, the: string, ord: string, noun: string) => {
      const o = at(pick(ORD_EN[ord.toLowerCase()]));
      return o === null ? _m : `${the} ${noun} “${o}”`;
    });
  out = out.replace(/\b(Option|option|Answer|answer|Choice|choice)\s+\(?([A-H])\)?(?![\p{L}])/gu,
    (_m, noun: string, letter: string) => {
      const o = at(letter.charCodeAt(0) - 65);
      return o === null ? _m : `${noun} “${o}”`;
    });
  return bad || citesOptionLabel(out, options.length) ? null : out;
}

/**
 * Une explication qui désigne une option par sa lettre, son numéro ou son rang deviendrait
 * fausse après le mélange des options (Q12 de l'examen 3 de HUM-285, 02/11 : « la première
 * option », mélangée depuis) : elle n'est jamais mélangée, et la vérification la rejette.
 */
export function citesOptionLabel(text: string, optionCount?: number): boolean {
  return citesOptionLetter(text, optionCount) || citesOptionRank(text);
}

/** Introduit une affirmation hypothétique que l'explication réfute ensuite (« affirmer qu'… », « claiming that… »). */
const CLAIM_INTRO = /\b(?:affirmer|dire|pr[ée]tendre|soutenir|penser|croire|supposer|avancer|objecter|sugg[ée]rer)\s+qu(?:e\b|['’])\s*|\b(?:claims?(?:ing)?|argu(?:es?|ing)|say(?:ing|s)?|suggest(?:s|ing)?|assum(?:es?|ing)|assert(?:s|ing)?)\s+that\s+/iu;

/** Découpe en phrases (bornes `.`, `!`, `?`), sans perdre la ponctuation qui les termine. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/u).filter((s) => s.trim());
}

/**
 * `clause` (ce que l'explication prête à tort à l'étudiant puis réfute) correspond-elle à une
 * option RÉELLEMENT proposée ? Trop courte pour juger (< 2 termes informatifs) : jamais signalée,
 * pour ne jamais rejeter à tort une explication légitime.
 */
function claimGrounded(clause: string, options: string[]): boolean {
  const wanted = tokenize(clause, 4).filter((t) => !PROOF_STOP_WORDS.has(t));
  if (wanted.length < 2) return true;
  const have = new Set(tokenize(options.join(" "), 3));
  const overlap = wanted.filter((t) => have.has(t)).length;
  return overlap / wanted.length >= 0.34;
}

/**
 * true si l'explication réfute une affirmation qui ne correspond à AUCUNE option réelle — elle
 * réfute donc un distracteur qui n'existe pas (job 17, 14/11, HUM-285 : une clé marginale nulle et
 * une « tokenisation » absentes des 4 options respectives). Repéré par phrase, jamais par
 * l'ensemble du texte : une seule phrase en trop ne doit pas faire perdre les autres.
 */
export function citesAbsentDistractor(text: string, options: string[]): boolean {
  return sentences(text).some((s) => {
    const m = CLAIM_INTRO.exec(s);
    return !!m && !claimGrounded(s.slice(m.index + m[0].length), options);
  });
}

/**
 * Retire les phrases qui réfutent une affirmation absente des options réelles (inspiré de
 * repairOptionRefs) : l'énoncé, la clé et les options réelles restent discutés. null si rien à
 * retirer, ou si la retirer viderait l'explication (le rejet habituel s'applique alors).
 */
export function repairAbsentDistractorRefs(text: string, options: string[]): string | null {
  const parts = sentences(text);
  const kept = parts.filter((s) => {
    const m = CLAIM_INTRO.exec(s);
    return !m || claimGrounded(s.slice(m.index + m[0].length), options);
  });
  if (kept.length === parts.length) return null;
  const out = kept.join(" ").trim();
  return out.length >= 20 && !citesAbsentDistractor(out, options) ? out : null;
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
export function shuffleQcmOptions<T extends { options: string[]; correct: number[]; misconceptions: string[]; rationale?: QcmRationale | null; explanation?: string }>(it: T, seed: number): T {
  const order = it.options.map((_, i) => i);
  const r = rng(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const where = new Map(order.map((from, to) => [from, to]));
  const out = {
    ...it,
    options: order.map((from) => it.options[from]),
    misconceptions: order.map((from) => it.misconceptions?.[from] ?? ""),
    correct: it.correct.map((k) => where.get(k) ?? k).sort((a, b) => a - b),
  };
  // La justification structurée suit les options, case par case, et l'explication est réassemblée.
  if (it.rationale) {
    out.rationale = permuteRationale(it.rationale, order);
    out.explanation = assembleExplanation(out.rationale, out.options, out.correct);
  }
  return out;
}

/** Réassemble l'explication d'un QCM à justification structurée depuis ses options actuelles (sans effet sinon). */
export function syncExplanation<T extends Pick<QcmItem, "options" | "correct" | "explanation"> & { rationale?: QcmRationale | null }>(it: T): T {
  if (it.rationale) it.explanation = assembleExplanation(it.rationale, it.options, it.correct);
  return it;
}

/**
 * Filet sur les raisons rendues par le modèle (le mécanisme principal reste la structure) : une
 * raison qui désigne une option par sa lettre ou son rang est réécrite d'après son contenu, dans
 * l'ordre où le modèle voyait les options, sinon effacée (elle sera réécrite seule) ; une
 * justification de la clé qui réfute aussi d'autres options est réduite à la clé.
 */
export function cleanRationale(r: QcmRationale, options: string[], correct: number[], stem = ""): QcmRationale {
  const piece = (t: string) => (t && citesOptionLabel(t, options.length) ? repairOptionRefs(t, options, correct) ?? "" : t);
  let key = piece(r.key);
  if (key && explanationIssues(key, options, correct, stem)) key = keyOnlyExplanation(key) ?? key;
  return { ...r, key, wrong: r.wrong.map((w, i) => (correct.includes(i) ? "" : piece(w))) };
}

const seedOf = (s: string) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);

/**
 * Extraits que voit le concepteur : la recherche plein texte, puis, pour chaque sujet, la fenêtre
 * de TOUT le corpus qui réunit le plus de ses mots (lib/course-grounding corpusWindows). Banc
 * HUM-285 du 13/11 : avec deux extraits de 900 caractères, le concepteur bâtissait des cadres
 * absents du cours (« la réponse la plus proportionnée », « coût moyen cumulé »), rejetés hors
 * cours puis régénérés sur les mêmes extraits, et l'examen s'arrêtait à 9 questions sur 20.
 */
async function generatorPassages(queries: string[]): Promise<{ src: string; text: string }[]> {
  const [fts, scan] = await Promise.all([
    coursePassages(queries).catch(() => []),
    corpusWindows(queries, { perQuery: 1, cap: 1500, budget: 9_000 }).catch(() => []),
  ]);
  return [...fts, ...scan.filter((p) => !fts.some((x) => x.text.includes(p.text.slice(0, 200)) || p.text.includes(x.text.slice(0, 200))))];
}

/** Pourquoi un QCM vérifié est trop faible pour être gardé tel quel, ou null. */
function weaknessOf(it: QcmItem): string | null {
  if (it.verified === 0) return it.judgeIssue ?? "clé non confirmée à la vérification à l'aveugle";
  const issue = it.judgeIssue ? ` (${it.judgeIssue})` : "";
  if (it.nameOnly) return `réussie avec les seuls noms des notions ou par élimination${issue}`;
  // K : les distracteurs éliminables nommés, pour une régénération ciblée (avant le défaut général du correcteur).
  if (it.trivialDistractors?.length) {
    return `distracteur(s) éliminable(s) sans connaître le cours : ${it.trivialDistractors.map((k) => `« ${(it.options[k] ?? "").slice(0, 80)} »`).join(", ")} — remplace-les par des notions ou définitions proches du cours`;
  }
  // Clé confirmée, mais le correcteur relève une ambiguïté, un indice ou un distracteur absurde.
  if (it.judgeOk === false) return `défaut relevé par le correcteur${issue}`;
  if (typeof it.discrimination === "number" && it.discrimination <= 2) return `pouvoir discriminant faible (${it.discrimination}/5)${issue}`;
  if (qcmLengthCue(it.options, it.correct)) return "la bonne option se repère à sa longueur";
  return null;
}

/** Part maximale de distracteurs triviaux dans un examen livré (critère « triviaux » du banc). */
const TRIVIAL_BUDGET = 0.1;

/** Part de distracteurs triviaux d'une sélection au-dessus du budget (banc : « triviaux »). */
export function overTrivialBudget(items: Pick<QcmItem, "options" | "correct" | "trivialDistractors">[]): boolean {
  const distractors = items.reduce((n, q) => n + Math.max(0, q.options.length - q.correct.length), 0);
  const trivial = items.reduce((n, q) => n + (q.trivialDistractors?.length ?? 0), 0);
  return distractors > 0 && trivial / distractors > TRIVIAL_BUDGET;
}

/**
 * Garde les meilleurs QCM déjà vérifiés tout en bornant à 10 % la part des distracteurs
 * signalés comme triviaux. Les candidats propres passent d'abord ; une question légèrement
 * imparfaite peut ensuite éviter un remboursement, sans que plusieurs lots dépassent ensemble
 * le budget de l'examen.
 */

export function selectWithinTrivialBudget<T extends Pick<QcmItem, "options" | "correct" | "trivialDistractors" | "discrimination"> & { topic?: string; judgeOk?: boolean | null; factId?: string | null }>(current: T[], candidates: T[], limit: number): T[] {
  const out = current.slice(0, limit);
  let distractors = out.reduce((n, q) => n + Math.max(0, q.options.length - q.correct.length), 0);
  let trivial = out.reduce((n, q) => n + (q.trivialDistractors?.length ?? 0), 0);
  // Un fait du cours, une question (lib/qcm-facts) : un candidat dont le fait est déjà retenu ne passe pas.
  const facts = new Set(out.map((q) => q.factId).filter(Boolean));
  const ranked = candidates.map((q, i) => ({ q, i })).sort((a, b) =>
    (a.q.trivialDistractors?.length ?? 0) - (b.q.trivialDistractors?.length ?? 0)
      // Clé confirmée mais défaut relevé par le correcteur : gardée, après les questions sans défaut.
      || Number(a.q.judgeOk === false) - Number(b.q.judgeOk === false)
      || (b.q.discrimination ?? 0) - (a.q.discrimination ?? 0)
      || a.i - b.i);
  const append = (q: T, enforceBudget = true) => {
    if (out.length >= limit || (q.factId && facts.has(q.factId))) return;
    const nextDistractors = distractors + Math.max(0, q.options.length - q.correct.length);
    const nextTrivial = trivial + (q.trivialDistractors?.length ?? 0);
    if (enforceBudget && nextDistractors > 0 && nextTrivial / nextDistractors > TRIVIAL_BUDGET) return;
    out.push(q);
    if (q.factId) facts.add(q.factId);
    distractors = nextDistractors;
    trivial = nextTrivial;
  };
  // Une question un peu moins discriminante sur un chapitre encore absent vaut mieux qu'une
  // seconde question propre sur le même thème. Le second passage remplit ensuite les places.
  const covered = new Set(out.map((q) => normalize(q.topic ?? "")).filter(Boolean));
  for (const { q } of ranked) {
    if (out.length >= limit) break;
    const topic = normalize(q.topic ?? "");
    if (!topic || covered.has(topic)) continue;
    const before = out.length;
    append(q);
    if (out.length > before) covered.add(topic);
  }
  for (const { q } of ranked) {
    if (out.length >= limit) break;
    if (out.includes(q)) continue;
    append(q);
  }
  // Le verdict interne est plus sévère que le banc externe et reste probabiliste. Une question
  // vérifiée, à clé confirmée et non rejetée est préférable à une place remboursée : après avoir
  // épuisé le budget cible, on complète avec les meilleurs résidus déjà payés, sans nouvel appel.
  for (const { q } of ranked) {
    if (out.length >= limit) break;
    if (out.includes(q)) continue;
    append(q, false);
  }
  return out;
}

/** Pool cumulatif : un candidat non sélectionné reste disponible pour les rondes suivantes. */
export function updateVerifiedCandidates<T extends Pick<QcmItem, "stem" | "options" | "correct" | "trivialDistractors" | "discrimination" | "verified"> & { topic?: string; rejected?: unknown }>(pool: T[], incoming: T[], limit: number): { pool: T[]; selected: T[] } {
  const byStem = new Map(pool.filter((q) => q.verified === 1 && !q.rejected).map((q) => [q.stem, q]));
  for (const q of incoming) {
    if (q.verified !== 1 || q.rejected) continue;
    byStem.set(q.stem, q);
  }
  const next = [...byStem.values()];
  return { pool: next, selected: selectWithinTrivialBudget([], next, limit) };
}

const REPLACEMENTS_SCHEMA = `{ "replacements": [ { "index": <numéro Q>, "distractors": [ { "option": <numéro de l'option remplacée>, "text": "<nouvelle option>", "misconception": "[procédé] l'idée fausse visée" } ], "explanation": "<explication de la clé, mise à jour>" } ] }`;
/** Sortie stricte du remplacement en justification structurée : la raison de chaque remplaçant est exigée. */
const REPLACEMENTS_JSON_SCHEMA = {
  type: "object",
  properties: { replacements: { type: "array", items: { type: "object", properties: {
    index: { type: "integer" },
    distractors: { type: "array", items: { type: "object", properties: {
      option: { type: "integer" }, text: { type: "string" }, misconception: { type: "string" }, why_wrong: { type: "string" },
    }, required: ["option", "text", "misconception", "why_wrong"], additionalProperties: false } },
  }, required: ["index", "distractors"], additionalProperties: false } } },
  required: ["replacements"], additionalProperties: false,
} as const;
/** Justification structurée : chaque remplaçant porte sa raison, rien d'autre n'est réécrit (lib/qcm-rationale). */
const REPLACEMENTS_SCHEMA_STRUCTURED = `{ "replacements": [ { "index": <numéro Q>, "distractors": [ { "option": <numéro de l'option remplacée>, "text": "<nouvelle option>", "misconception": "[procédé] l'idée fausse visée", "why_wrong": "<pourquoi CETTE nouvelle option est fausse selon le cours>" } ] } ] }`;

/**
 * DISTRACTEURS TRIVIAUX REMPLACÉS, PAS LA QUESTION — banc moteur du 04/11/2026 (CS-290) : 41 QCM
 * vérifiés sur 50 avaient au moins un distracteur éliminable sans le cours ; régénérer la question
 * entière jetait un énoncé et une clé justes, et l'item était perdu si le nouveau tirage en gardait
 * un. Un seul appel par ronde remplace les options relevées (taxonomie des distracteurs), avec
 * l'explication ; l'énoncé, la clé et les autres options restent. Le résultat est revérifié.
 */
async function replaceTrivialDistractorsBatch(items: QcmItem[], step: StepCb, language?: string): Promise<QcmItem[]> {
  const lang = languageName(language ?? examLanguageFor(currentCourse()))[1];
  // Banc du 04/11 : sans le cours sous les yeux, les remplaçants étaient eux aussi génériques et
  // re-signalés une fois sur deux ; ils se bâtissent sur des notions voisines des extraits.
  const passages = await coursePassages([...new Set(items.map((it) => it.topic).filter(Boolean))]).catch(() => []);
  // Toutes justifiées par la structure : seules les raisons des remplaçants sont écrites (sortie
  // plus courte) ; une seule à l'explication libre, et le paragraphe est redemandé comme avant.
  const structured = items.every((it) => !!it.rationale);
  const body = items.map((it, k) => [
    `Q${k}. ${sanitizeCorpus(it.stem)}`,
    ...it.options.map((o, j) => `   (${j}) ${sanitizeCorpus(o)}${it.correct.includes(j) ? "  (bonne réponse — à garder)" : (it.duplicateOptions ?? []).includes(j) ? "  ← À REMPLACER : répète une autre option (même notion) ; le nouveau distracteur nomme une notion VOISINE du cours que les autres options ne nomment pas" : (it.trivialDistractors ?? []).includes(j) ? "  ← À REMPLACER : se devine fausse sans connaître le cours, ou nomme une notion que le cours ne présente pas" : ""}`),
    it.sourceFact ? `   Fait du cours testé : ${sanitizeCorpus(it.sourceFact).slice(0, 400)}` : "",
  ].filter(Boolean).join("\n")).join("\n\n");
  const out = await completeJson<{ replacements: { index: number; distractors: { option: number; text: string; misconception?: string; why_wrong?: string }[]; explanation?: string }[] }>({
    model: "opus", ...QCM_CALL_LIMITS, ...(structured ? { json: { schema: REPLACEMENTS_JSON_SCHEMA } } : {}),
    prompt: [
      `Tu es l'équipe enseignante du cours. Dans chacun de ces QCM, les options marquées « À REMPLACER » se devinent fausses sans connaître le cours. Écris pour chacune UN nouveau distracteur, sans toucher à l'énoncé, à la bonne réponse ni aux autres options.`,
      ...DISTRACTOR_TAXONOMY,
      `RÈGLES : hors question de calcul ou de code, chaque nouveau distracteur est un [quasi-synonyme] : une AUTRE notion, étude ou technique présente dans les extraits du cours ci-dessous, donnée comme réponse à l'énoncé dans SES termes (elle reprend ses données autant que la bonne réponse ; jamais une caractéristique de cette autre notion que l'énoncé contredit) — jamais l'option remplacée retouchée, ni la bonne réponse avec une réserve ajoutée ou un sens inversé ; il est FAUX selon le cours mais paraît juste à un étudiant qui connaît le thème sans le détail ; il applique les MÊMES critères que la bonne réponse et se trompe sur un détail du cours. Interdits : simple substitution d'étiquette manifestement incompatible, lecture directe de chiffres, contradiction avec un critère déjà donné dans l'énoncé. Même registre, même structure et longueur comparable (±30 %) que la bonne réponse ; il ne dit jamais pourquoi il est faux ; aucun marqueur d'absolu ; il ne répète aucune autre option. ${structured ? `Pour chaque nouveau distracteur, "why_wrong" dit pourquoi IL est faux selon le cours (le détail qu'il contredit), sans citer d'autre option, ni lettre, ni rang.` : `Réécris aussi l'explication de la clé pour qu'elle couvre les options finales, en désignant les options par leur CONTENU, jamais par leur lettre ni leur rang.`} Tout en ${lang}.`,
      DATA_RULE,
      passages.length ? dataBlock("EXTRAITS DU COURS", passages) : "",
      "",
      body,
      "",
      `Réponds UNIQUEMENT avec ce JSON : ${structured ? REPLACEMENTS_SCHEMA_STRUCTURED : REPLACEMENTS_SCHEMA}`,
    ].join("\n"),
  }, { check: (v) => (Array.isArray(v?.replacements) ? null : "il manque la liste replacements") });
  const repaired = items.map((it, k) => {
    const r = out.replacements.find((x) => x.index === k);
    if (!r) return null;
    const options = it.options.slice();
    const misconceptions = it.misconceptions.slice();
    const whys = new Map<number, string>();
    for (const d of r.distractors ?? []) {
      if (!(it.trivialDistractors ?? []).includes(d.option) || typeof d.text !== "string" || !d.text.trim()) continue;
      options[d.option] = d.text.trim();
      misconceptions[d.option] = d.misconception ?? misconceptions[d.option] ?? "";
      whys.set(d.option, typeof d.why_wrong === "string" ? d.why_wrong.trim() : "");
    }
    // Job 23 (Q9) : un remplaçant qui nomme la même notion qu'une autre option donnait deux fois
    // « le biais de disponibilité » ; il est refusé, l'option d'avant reste (et reste signalée).
    for (const j of duplicateOptionIndices(options, it.correct)) {
      if (options[j] !== it.options[j]) { options[j] = it.options[j]; misconceptions[j] = it.misconceptions[j] ?? ""; whys.delete(j); }
    }
    if (options.every((o, j) => o === it.options[j])) return null;
    const reset = { verified: null, trivialDistractors: null, duplicateOptions: null, judgeIssue: null, judgeOk: null, discrimination: null, nameOnly: null } as const;
    // Justification structurée : la raison d'une option remplacée est invalidée et remplacée par
    // celle du remplaçant (même appel) ; les autres cases ne bougent pas. Sans raison rendue, la case
    // reste vide : la porte de sortie la fait écrire seule (jamais l'ancienne, qui visait l'option partie).
    if (it.rationale) {
      const changedIdx = options.map((o, j) => (o !== it.options[j] ? j : -1)).filter((j) => j >= 0);
      let rationale = invalidateRationale(it.rationale, changedIdx);
      rationale = cleanRationale({ ...rationale, wrong: rationale.wrong.map((w, j) => (changedIdx.includes(j) ? whys.get(j) ?? "" : w)) }, options, it.correct, it.stem);
      return syncExplanation({ ...it, options, misconceptions, rationale, ...reset } as QcmItem);
    }
    // L'explication doit réfuter les options FINALES : l'ancienne réfute souvent les distracteurs
    // remplacés (job 23 : neuf explications sur vingt réfutaient des options absentes).
    const written = r.explanation && !citesOptionLabel(r.explanation, options.length) ? r.explanation : null;
    // Boucle moteur, itération 4 (15/11) : l'une ou l'autre réfutait encore l'option retirée (« les
    // vulnérabilités zero-day ») sans que la revérification le relève ; ces phrases sont retirées.
    const removed = it.options.filter((o, j) => options[j] !== o);
    const pruned = [written, it.explanation].map((e) => (e ? withoutRemovedOptionRefs(e, removed, options, it.correct, it.stem) : null));
    const explanation = pruned.find((e) => !!e && !explanationIssues(e, options, it.correct, it.stem)) ?? pruned.find(Boolean) ?? written ?? it.explanation;
    return { ...it, options, misconceptions, explanation, ...reset } as QcmItem;
  });
  const sent = repaired.filter((x): x is QcmItem => !!x);
  if (!sent.length) return items;
  step(`${sent.length} QCM : distracteur(s) éliminable(s) remplacé(s), énoncé et clé gardés`, 0);
  // Rendus non vérifiés : l'appelant les revérifie en groupe (ronde) ou les ré-audite (audit final).
  let n = 0;
  return repaired.map((x, k) => (x ? { ...sent[n++], slot: items[k].slot } : items[k]));
}

type FinalQualityVerdict = { index: number; key: boolean; offCourse: boolean; trivial: number[] };

/** Applique les verdicts de l'audit final sans jamais conserver une clé fausse ou du hors-cours. */
export function applyFinalQualityVerdicts<T extends Pick<QcmItem, "options" | "correct"> & Partial<Pick<QcmItem, "verified" | "judgeOk" | "rejected" | "trivialDistractors">>>(items: T[], verdicts: FinalQualityVerdict[]): (T & Pick<QcmItem, "verified" | "judgeOk" | "rejected" | "trivialDistractors">)[] {
  const byIndex = new Map(verdicts.map((v) => [v.index, v]));
  return items.flatMap((it, index) => {
    const v = byIndex.get(index);
    if (!v || !v.key || v.offCourse) return [];
    // Les deux verdicts se cumulent : l'audit ne masque jamais un distracteur que la vérification a relevé.
    const trivial = replaceableDistractors([...(v.trivial ?? []), ...(it.trivialDistractors ?? [])], it);
    return [{ ...it, verified: 1, judgeOk: true, rejected: null, trivialDistractors: trivial.length ? trivial : null }];
  });
}

const FINAL_QUALITY_SCHEMA = {
  type: "object",
  properties: {
    verdicts: { type: "array", items: { type: "object", properties: {
      index: { type: "integer" }, key: { type: "boolean" }, offCourse: { type: "boolean" },
      trivial: { type: "array", items: { type: "integer" } },
    }, required: ["index", "key", "offCourse", "trivial"], additionalProperties: false } },
  }, required: ["verdicts"], additionalProperties: false,
} as const;

/**
 * Cases de justification encore vides (raison oubliée par la conception, effacée par le filet ou
 * non rendue par un remplacement) : écrites dans la revue finale, qui passe de toute façon sur
 * chaque candidat — aucun appel de plus. Champ ajouté au schéma seulement quand il y en a.
 */
const AUDIT_JUSTIFICATIONS = {
  type: "array",
  items: { type: "object", properties: {
    index: { type: "integer" }, key: { type: "string" },
    distractors: { type: "array", items: { type: "object", properties: { option_index: { type: "integer" }, why_wrong: { type: "string" } }, required: ["option_index", "why_wrong"], additionalProperties: false } },
  }, required: ["index", "key", "distractors"], additionalProperties: false },
} as const;

/** Consignes de l'audit de sortie, calquées sur la rubrique du banc (audit seul ou revue finale). */
const AUDIT_RULES = [
  `key : true seulement si la clé est juste et la seule défendable ; false si elle est fausse, si une autre option est au moins aussi défendable ou s'il manque une bonne réponse.`,
  `offCourse : true si la bonne réponse ou l'explication repose sur une notion ou un fait absent des extraits et qui n'est pas une connaissance générale de la matière. Un distracteur faux n'est pas hors cours.`,
  `trivial : indices des mauvaises options qu'un étudiant qui ne connaît PAS le cours élimine quand même : absurde, hors sujet, marqueur d'absolu évident, incohérence grammaticale ou longueur qui trahit ; et toute mauvaise option qui nomme la même notion qu'une autre option du QCM.`,
];

/** Un verdict d'audit par QCM, chacun bien formé. */
const verdictsCheck = (v: { verdicts?: unknown } | null | undefined, n: number): string | null =>
  Array.isArray(v?.verdicts) && v.verdicts.length >= n && v.verdicts.every((x) => typeof (x as { key?: unknown })?.key === "boolean") ? null : "il faut un verdict par QCM";

/** Étiquette d'un thème déjà couvert par une autre question de l'examen. */
const REPEAT_METHOD = "thème déjà couvert par une autre question : teste un AUTRE fait, une autre étude ou une autre condition";

/** Étiquette d'un sujet imposé par le focus de l'étudiant : un thème, pas une forme. */
const FOCUS_METHOD = "accent thématique demandé par l'étudiant : un thème, ignore toute indication de forme ou de nombre";

const ARCHITECT_QCM_RULES = [
  `RÈGLES D'ARCHITECTE QCM (impératives) :`,
  `  - Chaque DISTRACTEUR cible une IDÉE FAUSSE réelle et précise (une mauvaise intuition courante), JAMAIS du remplissage ni de l'absurde.`,
  `  - AUCUN indice qui trahit : la bonne option n'est ni plus longue ni plus détaillée ; pas de « toutes les réponses ci-dessus » ; cohérence grammaticale stem↔options ; options de longueur comparable ; pas de négations piégeuses gratuites.`,
  `  - INTERDIT : une clé qui récite la définition tandis que les distracteurs ne font que substituer des étiquettes manifestement incompatibles ; une lecture directe de chiffres ; des options réfutables par un critère déjà écrit dans l'énoncé. Chaque distracteur doit être une erreur plausible qui applique les MÊMES critères que la clé mais se trompe sur un détail du cours.`,
  `  - Teste la COMPRÉHENSION / le raisonnement, pas la récitation d'une définition.`,
  `  - Calibre la difficulté sur les VRAIS examens du cours (regarde les pages fournies).`,
  COURSE_TERMS_RULE,
  COURSE_MATTER_RULE,
];

/** Génère un LOT de QCM (1 appel LLM) couvrant des sujets donnés, au format du cours.
 *  `guidance` (optionnel, additif) : consignes supplémentaires injectées dans le prompt — sert au
 *  parcours de révision pour (a) bâtir des distracteurs sur les ERREURS RÉELLES de l'étudiant et
 *  (b) lister les énoncés déjà couverts à NE PAS répéter. Absent → comportement identique à avant.
 *  `opts.molds` (aligné aux topics) impose le MOULE de chaque question (ADN détecté) ;
 *  `opts.dna` active les figures (data-driven : seulement si le cours en a) + le cadrage appliqué. */
/** Sujet d'un QCM : la notion, sa méthode, le sous-thème nommé imposé (lib/coverage), ou le fait du cours à tester (lib/qcm-facts). */
export type QcmSlot = { label: string; method: string | null; subTheme?: string | null; fact?: CourseFact | null };

export async function generateQcmBatch(
  topics: QcmSlot[],
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
    /** Le cours a des annales : leur forme d'options fait foi, « classe ce cas » seulement si elles en ont. */
    withAnnales?: boolean;
    /** Sujets de TOUTES les questions de l'examen : un lot ne réutilise ni la fonction ni le scénario d'un autre. */
    examTopics?: string[];
    /** Énoncés déjà posés dans les examens précédents de ce cours : à ne pas reprendre. */
    previousStems?: string[];
    /** Consigne de l'étudiant (« Mets l'accent sur… ») : s'ajoute aux règles, sur chaque lot. */
    studentFocus?: string;
    /** Mode de réponse de l'examen ; absent → celui du format du cours, sinon réponse unique. */
    answerMode?: AnswerMode;
    /** Options de chaque question, celui de l'annale ; null → défaut de 4 pour une SCQ ; absent → celui du format du cours. */
    optionsPerQuestion?: number | null;
    /** Résumé du format RÉSOLU (lib/exam-format), cohérent avec le mode ; absent → celui de la détection. */
    formatSummary?: string;
    /** Faits testés par les questions de l'examen (lib/qcm-facts) : un lot n'en teste aucun autre que les siens. */
    examFacts?: CourseFact[];
    /** Tous les faits du cours : une question bâtie sur le passage d'un AUTRE fait lui est rattachée. */
    facts?: CourseFact[];
  } = {}
): Promise<QcmItem[]> {
  const fmt = await getFormatProfile();
  // Absents (révision) : ceux du format résolu du cours.
  const resolved = opts.answerMode && opts.optionsPerQuestion !== undefined ? null : await resolveExamFormat().catch(() => null);
  const mode = opts.answerMode ?? resolved?.answerMode ?? DEFAULT_ANSWER_MODE;
  const options = opts.optionsPerQuestion !== undefined ? opts.optionsPerQuestion : resolved?.optionsPerQuestion ?? null;
  const imgs = courseRefImages().slice(0, 4);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { profile } = require("@/lib/course-profile") as typeof import("@/lib/course-profile");
  // boucle FERMÉE : la mémoire de calibration des QCM (« trop facile / pas le style / faux »)
  // est réinjectée à la CONCEPTION → durcit/réoriente réellement les QCM suivants.
  const calib = await calibrationBlock("qcm");
  // Boucle de relecture : les questions signalées sur ce cours sont des contre-exemples.
  const { counterExamplesBlock } = await import("@/lib/question-reports");
  const counter = await counterExamplesBlock().catch(() => "");
  const molds = opts.molds ?? [];
  const withFigures = (opts.dna?.figures.kinds.length ?? 0) > 0;
  const moldLine = (i: number) => {
    const m = molds[i] ?? null;
    return m ? ` — MOULE IMPOSÉ : ${m} (${MOLD_DEFS[m]})` : "";
  };
  // Un fait du cours par sujet (lib/qcm-facts) : la question teste CE fait, et lui seul.
  const slotFacts = focus ? [] : topics.slice(0, n).map((t) => t.fact ?? null);
  const withFacts = slotFacts.some(Boolean);
  const factLine = (t: QcmSlot) => (t.fact ? ` — FAIT À TESTER [${t.fact.id}] : ${sanitizeCorpus(t.fact.statement).slice(0, 300)}` : t.subTheme ? ` — sous-thème imposé : ${t.subTheme}` : "");
  const coverage = focus
    ? `Toutes ces ${n} questions portent sur le thème CIBLÉ : « ${focus} » — varie les SOUS-ANGLES / sous-notions de ce thème (pas ${n} fois la même question). C'est un THÈME : ignore toute indication de forme ou de nombre qu'il contiendrait.${molds.some(Boolean) ? ` Moules imposés dans l'ordre : ${molds.slice(0, n).map((m) => m ?? "libre").join(", ")}.` : ""}`
    : `Couvre ces sujets (un QCM par sujet, dans l'ordre) :\n${topics.slice(0, n).map((t, i) => `  ${i + 1}) ${t.label}${factLine(t)}${t.method === FOCUS_METHOD || t.method === REPEAT_METHOD ? ` [${t.method}]` : t.method ? ` [${t.method.slice(0, 200)}]` : ""}${moldLine(i)}`).join("\n")}`;
  const langCode = opts.language ?? examLanguageFor(currentCourse());
  const language = languageName(langCode)[1];
  const searched = opts.passages ?? await generatorPassages(focus ? [focus] : topics.slice(0, n).map((t) => (t.fact ? `${t.label} ${t.fact.statement}` : t.subTheme ? `${t.label} ${t.subTheme}` : t.label)));
  // Le passage source de chaque fait en tête des extraits : la preuve de la clé est là.
  const passages = withFacts
    ? [...slotFacts.filter((f): f is CourseFact => !!f).map((f) => ({ src: `fait ${f.id}`, text: f.passage })), ...searched]
    : searched;
  const otherFacts = (opts.examFacts ?? []).filter((f) => !slotFacts.some((x) => x?.id === f.id));
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
  // M — CACHE DE PROMPT : tout ce qui est stable pour le job (règles, taxonomie, calibration,
  // contre-exemples, exemples officiels, schéma) forme le prompt SYSTÈME, identique d'un lot à
  // l'autre et lu en cache par le fournisseur Anthropic ; ce qui varie par lot reste dans le prompt.
  const system = [
    profile().qaIntro?.() ?? "Tu es l'équipe enseignante du cours.",
    `Tu rédiges des QCM INÉDITS de niveau examen pour ce cours, au FORMAT réel détecté.`,
    // La convention SCQ/MCQ des sources ne sert qu'en mode mixte : sinon le mode de l'examen la
    // remplace (un mode déclaré peut contredire une source qui dit « une seule réponse correcte »).
    fmt || opts.formatSummary ? `Format du cours : ${opts.formatSummary ?? fmt?.format_summary}${mode === "mixed" && fmt ? ` — convention SCQ/MCQ : ${fmt.scq_vs_mcq_convention}` : ""}.` : ``,
    imgs.length ? `Pages d'examens réelles à imiter (outil Read) :\n${imgs.map((p) => `  - ${p}`).join("\n")}` : ``,
    ``,
    ...ARCHITECT_QCM_RULES,
    answerModeRule(mode),
    options ? optionCountRule(options) : ``,
    opts.withAnnales ? OPTIONS_WITH_ANNALES : OPTIONS_WITHOUT_ANNALES,
    ...OPTION_RULES,
    explanationRule(),
    opts.withAnnales ? CLASSIFICATION_IF_ANNALES : NO_CLASSIFICATION,
    `  - LANGUE : toutes les questions, options et explications en ${language}.`,
    ``,
    ...DISTRACTOR_TAXONOMY,
    withFigures ? `  - Pour un moule figure_reading : ÉMETS "figure_spec" (contrat ci-dessous) — la question doit être RÉSOLUBLE depuis la figure seule.` : null,
    calib || null,
    counter || null,
    texture,
    withFigures ? `\n${figureSpecPromptBlock()}` : null,
    examples.length ? `\n${DATA_RULE}` : null,
    examples.length ? dataBlock(`QUESTIONS D'EXEMPLE OFFICIELLES de l'enseignant — imite leur STYLE (forme des options, niveau de détail, pièges), ne les recopie JAMAIS`, examples) : null,
    `Format de réponse : UNIQUEMENT l'objet JSON { "items": [ … ] } conforme à ce schéma, aucun fichier.`,
    JSON.stringify(batchSchema(mode, true, options, withFacts), null, 2),
  ].filter((l) => l != null && l !== "").join("\n");
  const prompt = [
    `Ce lot : ${n} QCM.`,
    // Avec des moules (ADN des annales) : la consigne historique. Sans : un scénario n'est
    // qu'un moyen de tester un fait ou une condition, jamais un cas à étiqueter (HUM-285).
    molds.some(Boolean)
      ? `  - RESPECTE le MOULE imposé de chaque question (recopie-le dans "mold"). Sauf pour le moule statement_truefalse, ANCRE la question dans un scénario concret ou un mini-calcul de l'idiome du cours (jamais une affirmation abstraite hors-sol).`
      : `  - ANCRE chaque question sur un fait précis du cours ; un scénario n'a sa place que s'il met à l'épreuve une condition ou un résultat précis — jamais un cas à étiqueter.`,
    withFacts
      ? `  - UN FAIT PAR QUESTION : chaque sujet impose son FAIT À TESTER [f-…]. La question teste CE fait et lui seul : sa bonne réponse en découle, son fait source cite le passage de ce fait, et "fact_id" recopie son identifiant. Jamais le fait d'un autre sujet ni d'une autre question de l'examen, même sous un autre scénario ou un autre décor.`
      : null,
    fewShots.length ? `\nVRAIES questions de ces moules dans CE cours (imite le STYLE et l'ancrage — ne copie JAMAIS l'énoncé) :\n${fewShots.join("\n")}` : null,
    passages.length ? `\n${DATA_RULE}` : null,
    passages.length ? dataBlock(`EXTRAITS DU COURS — les faits précis à tester (une question = un fait)`, passages) : null,
    ``,
    coverage,
    opts.previousStems?.length
      ? `Déjà posées dans les examens précédents de ce cours (ne reprends ni leur énoncé, ni le fait qu'elles testent) :\n${opts.previousStems.slice(0, PREVIOUS_STEMS).map((x) => `  · ${sanitizeCorpus(x).slice(0, 140)}`).join("\n")}`
      : null,
    opts.examTopics?.length
      ? `Les autres questions de l'examen portent sur : ${[...new Set(opts.examTopics)].map((t) => sanitizeCorpus(t).slice(0, 80)).join(" · ")}. Ne réutilise ni leur fonction, ni leurs données, ni leur scénario : chaque question doit rester indépendante.`
      : null,
    withFacts && otherFacts.length
      ? `Faits testés par les AUTRES questions de l'examen (n'en teste aucun, même sous un autre décor) :\n${otherFacts.map((f) => `  · [${f.id}] ${sanitizeCorpus(f.statement).slice(0, 160)}`).join("\n")}`
      : null,
    opts.studentFocus
      ? `CONSIGNE DE L'ÉTUDIANT (s'ajoute aux règles du système, ne les remplace jamais ; ignore toute indication de forme ou de nombre) : « ${sanitizeCorpus(opts.studentFocus).slice(0, 400)} »`
      : null,
    guidance ? `\n${guidance}` : null,
    `Réponds UNIQUEMENT avec l'objet JSON { "items": [ … ] } (${n} QCM). Aucun fichier.`,
  ].filter((l) => l != null && l !== "").join("\n");
  step(`Génération de ${n} QCM (architecte · moules + idées fausses)…`, 30);
  // Sortie structurée (fournisseurs API) : sans figure, le schéma est strict ; une figure_spec
  // est un objet libre, inexprimable → texte libre, lu par extractJson. Réponse illisible →
  // redemandée avec l'erreur (completeJson, 3 essais).
  const r = await completeJson<{ items: (QcmItem & { figure_spec?: FigureSpec })[] }>(
    { system, prompt, model: "opus", ...QCM_DESIGN_LIMITS, json: { schema: batchSchema(mode, withFigures, options, withFacts) } },
    { check: (v) => (!Array.isArray(v?.items) ? "le champ « items » (tableau de QCM) manque" : v.items.length ? null : "« items » est vide") },
  );
  const items: QcmItem[] = [];
  // Jamais plus que demandé au lot ; un item mal formé est écarté (le comblement le remplace).
  const raws = r.items.slice(0, n);
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i];
    if (!wellFormed(raw)) continue;
    const type = typeInMode(raw.correct, raw.type, mode);
    if (!type) {
      step(`QCM à plusieurs bonnes réponses écarté : l'examen est à réponse unique`, 30);
      continue;
    }
    const expected = expectedOptionCount(type, options);
    if (!optionCountFits(raw.options.length, expected)) {
      step(`QCM à ${raw.options.length} options écarté (il en faut ${expected}) : son sujet est comblé`, 30);
      continue;
    }
    // Un caractère que le PDF ne sait pas écrire y deviendrait une espace (« A ⊆ B » → « A   B »),
    // dans l'énoncé, une option ou le corrigé (explication, idées fausses).
    const unprintable = untypesetChars(raw.stem, raw.options, raw.explanation, raw.misconceptions, (raw as { justification?: unknown }).justification);
    if (unprintable.length) {
      step(`QCM écarté : ${unprintable.join(" ")} ne s'imprime pas dans le PDF, son sujet est comblé`, 30);
      continue;
    }
    const imposed = molds[i] ?? null;
    const fact = (raw as { source_fact?: unknown }).source_fact;
    const base: QcmItem = {
      ...raw,
      type,
      misconceptions: Array.isArray(raw.misconceptions) ? raw.misconceptions : [],
      verified: null,
      mold: normalizeMold(raw.mold) ?? imposed,
      figureSpec: null,
      figureFile: null,
      figureTruth: null,
      sourceFact: typeof fact === "string" ? fact : null,
      slot: i,
    };
    delete (base as { source_fact?: unknown }).source_fact;
    if (withFacts) {
      // Le fait que le concepteur dit tester, s'il est l'un de ceux du lot ; sinon celui du sujet.
      // Une preuve tirée du passage d'un AUTRE fait du cours rattache la question à ce fait-là.
      const named = (raw as { fact_id?: unknown }).fact_id;
      const own = slotFacts.find((f) => !!f && typeof named === "string" && f.id === named.trim()) ?? slotFacts[i] ?? null;
      base.factId = attributedFact(base.sourceFact, own, opts.facts ?? [])?.id ?? null;
    }
    delete (base as { fact_id?: unknown }).fact_id;
    // Justification structurée (lib/qcm-rationale) : rangée par option, sur les options telles que le
    // modèle les a numérotées ; l'explication en est assemblée, et suivra le mélange case par case.
    const justification = (raw as { justification?: unknown }).justification;
    delete (base as { justification?: unknown }).justification;
    const rationale = structuredExplanationsEnabled() ? rationaleFromModel(justification, base.options.length, base.correct, langCode) : null;
    if (rationale) {
      base.rationale = cleanRationale(rationale, base.options, base.correct, base.stem);
      syncExplanation(base);
    }
    // Paragraphe libre (interrupteur coupé, ou réponse sans justification) : les réparations d'avant.
    // Une explication qui renvoie à une option par son rang ou sa lettre est réécrite d'après son
    // contenu, AVANT le mélange (sinon rejetée puis régénérée à la vérification).
    if (!base.rationale && Array.isArray(base.options) && Array.isArray(base.correct) && citesOptionLabel(base.explanation ?? "", base.options.length)) {
      const fixed = repairOptionRefs(base.explanation ?? "", base.options, base.correct);
      if (fixed) base.explanation = fixed;
    }
    // Une explication qui réfute une affirmation absente des options (plus de distracteurs
    // réfutés qu'il n'y en a) est réécrite sur les options réelles, AVANT le mélange.
    if (!base.rationale && Array.isArray(base.options) && citesAbsentDistractor(base.explanation ?? "", base.options)) {
      const fixed = repairAbsentDistractorRefs(base.explanation ?? "", base.options);
      if (fixed) base.explanation = fixed;
    }
    // Position de la bonne réponse mélangée (graine = l'énoncé : reproductible), jamais pour une question à figure.
    const it = Array.isArray(base.options) && Array.isArray(base.correct) && !(raw as { figure_spec?: unknown }).figure_spec && (!!base.rationale || !citesOptionLabel(base.explanation ?? "", base.options.length))
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

/** Réponses du juge qui ne signalent rien. */
export const NO_FLAG = /^(?:|[-—.…]+|none\.?|no|nothing|n\/?a|null|aucune?\.?|rien\.?|néant|non|ras|ok)$/i;

const PROOF_STOP_WORDS = new Set([
  "avec", "dans", "des", "elle", "elles", "entre", "est", "les", "leur", "leurs", "mais", "par", "pas", "plus", "pour", "que", "qui", "sans", "selon", "son", "sont", "sur", "une",
  "and", "are", "for", "from", "into", "that", "the", "their", "this", "was", "were", "with",
]);

/**
 * Une preuve peut être reformulée par le concepteur, coupée sur plusieurs lignes par un PDF ou
 * contenir une notation LaTeX différemment échappée. Les nombres doivent tous rester présents et
 * au moins la moitié des termes informatifs doit se retrouver dans les passages du cours.
 */
function sourceFactSupported(sourceFact: string, passages: string): boolean {
  const compact = (s: string) => normalize(s)
    .replace(/\\(?:mathrm|text|operatorname)\s*\{([^}]*)\}/g, "$1")
    .replace(/([\p{L}\p{N}])-\s*\n\s*([\p{L}\p{N}])/gu, "$1$2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const source = compact(sourceFact);
  const course = compact(passages);
  if (source.length < 20) return false;
  if (course.includes(source)) return true;
  const wanted = [...new Set(tokenize(source, 2).filter((t) => !PROOF_STOP_WORDS.has(t)))];
  if (wanted.length < 4) return false;
  const have = new Set(tokenize(course, 2));
  const numbers = wanted.filter((t) => /^\d/.test(t));
  if (numbers.some((t) => !have.has(t))) return false;
  const overlap = wanted.filter((t) => have.has(t)).length;
  return overlap >= 4 && overlap / wanted.length >= 0.5;
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
          course_terms: { type: "array", items: { type: "string" }, description: "Les notions nommées dont dépend la BONNE réponse, chacune écrite EXACTEMENT comme dans les extraits du cours (copie le terme du cours)." },
          off_course: { type: "string", description: "Non vide si la bonne réponse ou l'explication DÉPEND d'une notion ou d'un fait ABSENT des extraits, ou que le cours définit AUTREMENT : laquelle, et ce que dit le cours. Vide si les extraits permettent de résoudre, même avec un synonyme usuel. Un distracteur faux n'est pas hors cours." },
          off_course_terms: { type: "array", items: { type: "string" }, description: "Les notions ou faits précis que off_course dit absents, écrits comme dans la question (ils seront cherchés dans tout le cours). Vide si off_course est vide." },
          off_course_key: { type: "boolean", description: "true si ce que off_course dit absent porte la BONNE réponse ou l'explication ; false si seules des MAUVAISES options le nomment. false si off_course est vide." },
          off_course_options: { type: "array", items: { type: "integer" }, description: "Indices des MAUVAISES options qui nomment ce que off_course dit absent du cours. Vide si off_course est vide." },
          off_matter: { type: "string", description: "Non vide si la question porte sur les modalités d'examen (format, barème, grille ou critères d'évaluation, consignes), sur la forme d'un rendu (poster, essai, bibliographie) ou sur l'organisation du cours (plan, ordre des chapitres) plutôt que sur sa matière : ce qu'elle teste. Vide sinon." },
          trivial_distractors: { type: "array", items: { type: "integer" }, description: "Indices des MAUVAISES options qu'un étudiant élimine sans connaître le cours : absurde, hors sujet, générique, réfutable par le bon sens, par un calcul élémentaire ou par un critère déjà donné dans l'énoncé ; marqueur absolu, faute grammaticale avec l'énoncé, ou longueur qui trahit la réponse. Liste vide si toutes sont plausibles." },
          definition_mismatch: { type: "string", description: "Chaque définition employée ou sous-entendue (énoncé, clé, distracteurs, explication) comparée à celle des extraits du cours. Non vide si l'une est PLUS ÉTROITE (une condition ajoutée), PLUS LARGE (une condition oubliée), ou si deux notions du cours sont confondues : laquelle, ce que dit la question, ce que dit le cours. Vide sinon." },
          definition_mismatch_key: { type: "boolean", description: "true si la définition différente est celle de l'énoncé, de la BONNE réponse ou de l'explication ; false si seules des MAUVAISES options la déforment (c'est le rôle d'un distracteur). false si definition_mismatch est vide." },
        },
        required: ["index", "correct", "ok", "discrimination", "name_only", "course_terms", "off_course", "off_course_terms", "off_course_key", "off_course_options", "off_matter", "trivial_distractors", "definition_mismatch", "definition_mismatch_key"],
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
  /** Rejette l'item (jamais gardé tel quel) ; `advice` guide sa régénération. */
  const reject = (q: QcmItem, reason: string, advice: string) => {
    q.verified = 0;
    q.rejected = reason.slice(0, 400);
    q.judgeIssue = `${q.rejected} — ${advice}`;
    benchTrace("qcm.rejected", { stem: q.stem, options: q.options, correct: q.correct, reason: q.rejected });
    step(`QCM rejeté : ${q.rejected.slice(0, 160)}`, 70);
  };
  // Déterministe, avant le correcteur (et même s'il échoue) : une explication qui désigne une
  // option par sa position ou sa lettre est fausse dès que les options sont mélangées.
  for (const q of items) {
    // Job 23 (Q9) : deux options « Le biais de disponibilité, soit… » ; la seconde est remplacée
    // comme un distracteur trivial (énoncé et clé gardés), que le correcteur la relève ou non.
    const dup = duplicateOptionIndices(q.options, q.correct ?? []);
    q.duplicateOptions = dup.length ? dup : null;
    // Justification structurée : l'explication est assemblée depuis les options réelles, ces deux
    // contrôles de texte libre n'ont rien à y chercher ; une raison fautive est effacée et réécrite seule.
    if (q.rationale) { q.rationale = cleanRationale(q.rationale, q.options, q.correct ?? [], q.stem); syncExplanation(q); }
    else if (citesOptionLabel(q.explanation ?? "", q.options.length)) reject(q, "explication qui désigne une option par sa position ou sa lettre", "désigne chaque option par son contenu dans l'explication, jamais par son rang (« la première ») ni sa lettre");
    // Idem pour une explication qui réfute un distracteur absent (ex. replaceTrivialDistractorsBatch
    // réécrit l'explication sans repasser par la réparation faite à la conception) : réécrite sur
    // les options réelles quand c'est possible, sinon rejetée comme un défaut classique.
    else if (citesAbsentDistractor(q.explanation ?? "", q.options)) {
      const fixed = repairAbsentDistractorRefs(q.explanation ?? "", q.options);
      if (fixed) q.explanation = fixed;
      else reject(q, "explication qui réfute une affirmation absente des options", "ne réfute que les options réellement proposées, jamais une affirmation qui n'y figure pas");
    }
  }
  // Le correcteur ne voit que les questions encore en lice, sous leur numéro dans le lot.
  const judged = items.filter((q) => !q.rejected);
  if (!judged.length) return items;
  const blind = items.map((q, i) => (q.rejected ? null :
    `Q${i}. [${q.type}]${q.figureFile ? ` [FIGURE : ouvre ${path.join(path.relative(process.cwd(), examsDir()), q.figureFile)} avec l'outil Read]` : ""} ${q.stem}\n${q.options.map((o, k) => `   (${k}) ${o}`).join("\n")}`
  )).filter(Boolean).join("\n\n");
  const figDirs = judged.some((q) => q.figureFile) ? [examsDir()] : [];
  // la mémoire de calibration des QCM est aussi réinjectée à la CRITIQUE : un « trop facile »
  // passé rend la vérif plus sévère sur la trivialité/les indices qui trahissent.
  const calib = await calibrationBlock("qcm");
  // DÉFINITIONS DU COURS : le juge résout et contrôle avec celles du cours, pas celles du web.
  // Autour du fait que teste chaque question, en fenêtres larges (banc HUM-285 du 02/11 : deux
  // extraits de 700 caractères par sujet, et 22 à 27 questions justes rejetées « hors cours »).
  const passages = await verifierPassages(judged).catch(() => []);
  // Cache de prompt (M) : consignes et schéma stables dans le système, lots et extraits à part.
  const system = [
    `Tu es un correcteur rigoureux du cours. Pour CHAQUE QCM fourni, RÉSOUS-LE toi-même de zéro (sans clé fournie) et donne la/les bonne(s) réponse(s) par INDEX.`,
    `Quand des extraits du cours sont fournis, résous et juge avec LEURS DÉFINITIONS, jamais avec celles d'une autre source. course_terms : les notions dont dépend la bonne réponse, écrites comme dans le cours. off_course : une notion ou un fait dont DÉPEND la bonne réponse ou l'explication, absent des extraits ou que le cours définit autrement (vide si les extraits permettent de résoudre, même avec un synonyme usuel de la matière) ; un distracteur qui n'est qu'une affirmation fausse (résultat inversé, condition changée) n'est pas hors cours, c'est son rôle. Les extraits ne couvrent pas tout le cours : nomme dans off_course_terms ce que tu dis absent, on le cherchera dans tout le cours.`,
    `DÉFINITIONS (definition_mismatch) : compare chaque définition que la question emploie ou sous-entend à celle des extraits. Une définition plus étroite (une condition ajoutée, « seulement si… »), plus large (une condition oubliée) que celle du cours, ou deux notions voisines confondues rendent la question fausse, même si sa clé est cohérente avec sa propre définition. definition_mismatch_key : true si cette définition est celle de l'énoncé, de la bonne réponse ou de l'explication ; false si seule une MAUVAISE option déforme la définition, car c'est le rôle d'un distracteur.`,
    `Signale si : la question est ambiguë (2 réponses défendables), ou une mauvaise option s'élimine sans connaître le cours — absurdité, hors sujet, marqueur absolu, grammaire, longueur, calcul élémentaire manifestement faux, ou contradiction avec un critère déjà donné dans l'énoncé. Compte aussi comme triviaux : une substitution d'étiquettes proches mais manifestement incompatibles quand la clé récite la définition ; la lecture directe des chiffres fournis sans calcul ni interprétation ; une option qui n'applique pas les mêmes critères que la clé. Des distracteurs plausibles doivent partager les mêmes critères et ne différer que par un détail qu'il faut connaître du cours. Ajoute chaque index à trivial_distractors, même si l'option illustre une erreur fréquente.`,
    `off_matter : ce que teste une question qui porte sur les modalités d'examen (format, barème, grille ou critères d'évaluation, consignes), sur la forme d'un rendu (poster, essai, bibliographie) ou sur l'organisation du cours (plan, ordre des chapitres) au lieu de sa matière (vide sinon).`,
    `Note aussi son POUVOIR DISCRIMINANT (discrimination, 1 à 5) : mets-toi à la place d'un étudiant qui ne connaît que les noms des notions du cours — pas leurs conditions, pas les résultats des études. S'il la réussit (ou élimine assez d'options pour la deviner), discrimination ≤ 2 et name_only = true.`,
    calib ? `${calib}\nÀ la lumière de ces leçons, sois SÉVÈRE : signale aussi (issue) tout QCM trop trivial / au distracteur trop faible si l'étudiant a jugé ce type « trop facile ».` : null,
    `Format de réponse : UNIQUEMENT l'objet JSON conforme à ce schéma.`,
    JSON.stringify(VERIFY_SCHEMA, null, 2),
  ].filter((l) => l != null).join("\n");
  const prompt = [
    passages.length ? null : `Aucun extrait du cours n'est fourni pour ce lot : laisse off_course vide.`,
    figDirs.length ? `Certaines questions ont une FIGURE : OUVRE le PNG indiqué (outil Read) et résous DEPUIS la figure. Si la figure ne suffit pas à répondre, mets ok=false avec issue="figure insuffisante".` : null,
    passages.length ? `\n${DATA_RULE}` : null,
    passages.length ? dataBlock(`EXTRAITS DU COURS — les définitions qui font foi`, passages) : null,
    ``,
    blind,
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON { "results": [ … ] } conforme.`,
  ].filter((l) => l != null).join("\n");
  step("Vérification à l'aveugle des QCM (résolution indépendante, figures vues)…", 70);
  let res: { results: { index: number; correct: number[]; ok: boolean; issue?: string; discrimination?: number; name_only?: boolean; course_terms?: string[]; off_course?: string; off_course_terms?: string[]; off_course_key?: boolean; off_course_options?: number[]; off_matter?: string; trivial_distractors?: number[]; definition_mismatch?: string; definition_mismatch_key?: boolean }[] };
  try {
    res = await completeJson(
      { system, prompt, model: "opus", ...QCM_VERIFY_LIMITS, addDirs: figDirs, json: { schema: VERIFY_SCHEMA } },
      { check: (v) => (Array.isArray((v as { results?: unknown })?.results) ? null : "le champ « results » manque") },
    );
  } catch { return items; } // fallback honnête : non vérifiés
  // Sortie du modèle non garantie (banc du 04/11 : une clé rendue en nombre, des options en chaîne) :
  // chaque verdict est ramené à sa forme une fois, à la lecture, plutôt que de faire planter le lot.
  const ints = (x: unknown): number[] => (Array.isArray(x) ? x.filter((k): k is number => Number.isInteger(k)) : Number.isInteger(x) ? [x as number] : []);
  res.results = (Array.isArray(res.results) ? res.results : []).filter((r) => r && Number.isInteger(r.index)).map((r) => ({
    ...r, correct: ints(r.correct), trivial_distractors: ints(r.trivial_distractors), off_course_options: ints(r.off_course_options),
    course_terms: Array.isArray(r.course_terms) ? r.course_terms : [], off_course_terms: Array.isArray(r.off_course_terms) ? r.off_course_terms : [],
  }));
  // Contrôle DÉTERMINISTE des termes que le juge dit avoir lus dans le cours : une notion
  // inventée (« status quo bias », absent du corpus de CS-290) ne passe pas parce que le
  // juge l'a crue du cours.
  const termsOf = (r: { course_terms?: unknown }) => (Array.isArray(r.course_terms) ? r.course_terms.filter((t): t is string => typeof t === "string") : []);
  const absent = new Set((await absentCourseTerms((res.results ?? []).flatMap(termsOf))).map((t) => normalize(t)));
  // Chiffres du fait testé et de la clé introuvables dans tout le cours (banc HUM-285 du 13/11 :
  // « hausse de 14 % des tickets », absent des supports) : la question repose sur un chiffre
  // inventé. Ceux de la seule explication relèvent du correcteur (réécriture, pas rejet).
  const numbersOf = (q: QcmItem) => factNumbers([q.sourceFact ?? "", ...(q.correct ?? []).map((k) => q.options[k] ?? "")].join(" "));
  const absentNumbers = new Set(await absentCourseNumbers(items.flatMap(numbersOf)));
  const offCourseAdvice = "n'utilise que les notions et les définitions des extraits du cours";
  /** Jugées hors cours par le correcteur seul : rejetées seulement après une recherche dans tout le cours. */
  const appeals: { q: QcmItem; flag: OffCourseFlag }[] = [];
  for (const r of res.results ?? []) {
    const q = items[r.index];
    if (!q || q.rejected) continue;
    // Notion de la clé introuvable MOT POUR MOT dans tout le corpus (contrôle déterministe) : soumise
    // au second regard comme un signalement. Banc du 04/11 (CS-290) : le correcteur recopie en
    // paraphrase ou en traduction (« keyword filter false positive », « mask booléen combiné avec & »
    // pour un cours en anglais) et le rejet immédiat écartait des questions justes. Sans aucun passage
    // sur la notion, le second regard confirme le rejet sans appel (lib/qcm-evidence).
    const missing = [...termsOf(r).filter((t) => absent.has(normalize(t.trim()))), ...numbersOf(q).filter((n) => absentNumbers.has(n))];
    // Un signalement du juge ne compte que s'il a VU des extraits et qu'il nomme quelque chose
    // (« None », « Aucune », « N/A » ne rejettent rien) : jamais de rejet faute de pouvoir vérifier.
    const said = (x: unknown) => (passages.length && typeof x === "string" && !NO_FLAG.test(x.trim()) ? x.trim() : "");
    // Banc du 04/11 (CS-290) : la plupart des rejets « hors cours » venaient d'une MAUVAISE option
    // qui nommait une notion absente du cours (« selection bias », « shadow banning ») : la question
    // était jetée pour un distracteur. Seule la clé ou l'explication hors cours rejette désormais ;
    // une option hors cours est remplacée comme un distracteur trivial.
    const offOptions = Array.isArray(r.off_course_options)
      ? r.off_course_options.filter((k) => Number.isInteger(k) && k >= 0 && k < q.options.length && !(q.correct ?? []).includes(k))
      : [];
    const distractorOnly = !!said(r.off_course) && r.off_course_key === false && offOptions.length > 0;
    const flagged = distractorOnly ? "" : said(r.off_course);
    // B — mock 4 de CS-290 : « sensitive » réduit aux attributs protégés par la loi (le cours : loi
    // OU éthique) ; une définition qui s'écarte de celle du cours rejette la question comme une notion
    // absente, et comme elle, seulement après une recherche dans tout le cours. Une définition
    // déformée par une MAUVAISE option, elle, fait de cette option un distracteur : banc HUM-285 du
    // 15/11, 14 seconds regards sur 64 appels pour « L'option 3 confond correction et prévention »,
    // tous conclus « trouvé dans le cours ». Champ absent (fournisseur sans schéma) : la clé est en cause.
    const mismatch = r.definition_mismatch_key === false ? "" : said(r.definition_mismatch);
    if (missing.length || flagged || mismatch) {
      const named = Array.isArray(r.off_course_terms) ? r.off_course_terms.filter((t): t is string => typeof t === "string" && !!t.trim()) : [];
      const terms = [...new Set([...missing, ...named])];
      const reason = [missing.length ? `absent du cours : ${missing.join(", ").slice(0, 220)}` : "", flagged, mismatch ? `définition différente du cours : ${mismatch}` : ""].filter(Boolean).join(" ; ");
      appeals.push({ q, flag: { ...q, reason, terms } });
    }
    // Une question sur l'évaluation du cours (grille, consignes, forme d'un rendu) ne teste pas sa matière.
    const offMatter = typeof r.off_matter === "string" && !NO_FLAG.test(r.off_matter.trim()) ? r.off_matter.trim().slice(0, 240) : "";
    if (offMatter) {
      reject(q, `hors matière : ${offMatter}`, "teste un fait de la matière du cours, jamais les modalités d'examen ni la forme d'un rendu");
      continue;
    }
    q.discrimination = Number.isInteger(r.discrimination) ? Math.max(1, Math.min(5, r.discrimination!)) : null;
    q.nameOnly = typeof r.name_only === "boolean" ? r.name_only : null;
    q.judgeIssue = r.issue?.trim() ? r.issue.trim().slice(0, 240) : null;
    // Plausibilité de chaque distracteur (une bonne réponse n'en est jamais un).
    const trivial = replaceableDistractors([
      ...(Array.isArray(r.trivial_distractors) ? r.trivial_distractors : []),
      ...(distractorOnly ? offOptions : []),
      ...(q.duplicateOptions ?? []),
    ], q);
    q.trivialDistractors = trivial.length ? trivial : null;
    const keyMatch = JSON.stringify([...(q.correct ?? [])].sort()) === JSON.stringify([...(r.correct ?? [])].sort());
    // Une question à réponse unique que le juge résout avec 0 ou plusieurs réponses est ambiguë :
    // ni sa clé ni son type ne sont fiables (« SCQ » avec deux clés, banc du 28/10) → à régénérer.
    if (q.type === "scq" && (r.correct?.length ?? 0) !== 1) {
      q.verified = 0;
      q.judgeIssue = `question à réponse unique avec plusieurs réponses défendables${r.issue ? ` (${r.issue.trim().slice(0, 160)})` : ""}`;
      continue;
    }
    q.judgeOk = !!r.ok && keyMatch;
    if (keyMatch) { q.verified = 1; continue; }
    q.verified = 0;
    if (!r.correct?.length) continue;
    // Le correcteur trouve une AUTRE réponse que la clé : l'explication défend la clé d'origine,
    // la remplacer donnait une clé et une explication contradictoires (HUM-285, Q19 du 02/11).
    // L'item est régénéré avec ce que le correcteur a trouvé, sinon écarté ; jamais corrigé en place.
    const found = r.correct.map((k) => `« ${sanitizeCorpus(q.options[k] ?? `option ${k}`).slice(0, 120)} »`).join(", ");
    reject(q, `clé contestée : le correcteur trouve ${found}${q.judgeIssue ? ` (${q.judgeIssue})` : ""}`, "vérifie la réponse et écris une explication qui la justifie");
  }
  // Second regard sur les questions jugées hors cours (et pas déjà rejetées pour une autre raison).
  const pending = appeals.filter((a) => !a.q.rejected);
  if (pending.length) {
    const courseEvidence = passages.map((p) => p.text).join("\n");
    // Fait source retrouvé dans le cours : la clé est prouvée, un second regard trop sévère ne la
    // rejette pas. Il tourne quand même, car seul lui voit qu'une EXPLICATION sort du cours.
    const grounded = new Set(pending.filter((a) => sourceFactSupported(a.q.sourceFact ?? "", courseEvidence)));
    const verdicts = await secondLookOffCourse(pending.map((a) => a.flag));
    const confirmedOf = (i: number) => (verdicts[i].reason && !NO_FLAG.test(verdicts[i].reason) ? verdicts[i].reason : "");
    // Seule l'explication est hors cours : elle est réécrite sur les passages du cours, la question
    // (énoncé, clé confirmée à l'aveugle, options) est gardée. Réécriture en échec : rejet.
    // Justification structurée : toutes ses cases sont réécrites sur les passages du cours, en un
    // appel du même type que le paragraphe libre ; acceptée seulement complète (une raison par distracteur).
    const toRewrite = pending.map((a, i) => ({ a, i })).filter(({ i }) => confirmedOf(i) && verdicts[i].explanationOnly);
    const lang = languageName(examLanguageFor(currentCourse()))[1];
    const freeRewrite = toRewrite.filter(({ a }) => !a.q.rationale);
    const structRewrite = toRewrite.filter(({ a }) => !!a.q.rationale);
    const [rewrittenFree, rewrittenStruct] = await Promise.all([
      freeRewrite.length ? rewriteExplanations(freeRewrite.map(({ a, i }) => ({ ...a.q, reason: confirmedOf(i), passages: verdicts[i].passages })), lang) : Promise.resolve([] as (string | null)[]),
      structRewrite.length
        ? writeJustifications(structRewrite.map(({ a, i }) => ({ ...a.q, key: a.q.rationale!.key, wrong: a.q.rationale!.wrong, want: { key: true, options: distractorIndices(a.q.options.length, a.q.correct) }, reason: `hors cours dans l'ancienne justification : ${confirmedOf(i)}` })), lang, [...new Set(structRewrite.flatMap(({ i }) => verdicts[i].passages))])
        : Promise.resolve([] as Awaited<ReturnType<typeof writeJustifications>>),
    ]);
    pending.forEach((a, i) => {
      const confirmed = confirmedOf(i);
      const ks = structRewrite.findIndex((x) => x.i === i);
      if (confirmed && ks >= 0) {
        const all = { key: true, options: distractorIndices(a.q.options.length, a.q.correct) };
        // Cases repartant de zéro : rien de l'ancienne justification hors cours ne reste.
        const next = cleanRationale(fillRationale({ ...a.q.rationale!, key: "", wrong: a.q.rationale!.wrong.map(() => "") }, rewrittenStruct[ks], all, a.q.options.length, a.q.correct), a.q.options, a.q.correct, a.q.stem);
        if (rationaleCheck(next, a.q.options.length, a.q.correct).ok) {
          a.q.rationale = next;
          syncExplanation(a.q);
          step(`QCM gardé : justification réécrite sur le cours (${confirmed.slice(0, 100)})`, 70);
          return;
        }
      }
      const k = freeRewrite.findIndex((x) => x.i === i);
      const text = k >= 0 ? rewrittenFree[k] : null;
      if (confirmed && text && !citesOptionLabel(text, a.q.options.length)) {
        a.q.explanation = text;
        step(`QCM gardé : explication réécrite sur le cours (${confirmed.slice(0, 100)})`, 70);
      } else if (confirmed && grounded.has(a)) {
        // Clé prouvée par le cours : ni un second regard trop sévère ni une réécriture d'explication
        // en échec ne font un faux rejet.
        step(`QCM gardé : preuve du cours retrouvée, rejet du second regard écarté (${confirmed.slice(0, 100)})`, 70);
      } else if (confirmed) reject(a.q, `hors cours : ${confirmed.slice(0, 240)}`, offCourseAdvice);
      else step(`QCM gardé : jugé hors cours sur les extraits, mais trouvé dans le cours (${a.flag.reason.slice(0, 100)})`, 70);
    });
  }
  return items;
}

/**
 * Énoncés et thèmes des questions des derniers examens de ce cours (base du tenant : ceux de
 * l'utilisateur), QCM et OUVERTES : banc rs-mixte du 17/11, trois QCM reprenaient deux ouvertes
 * d'un examen précédent, invisibles ici. Les ouvertes d'un examen passent avant ses QCM : la borne
 * ne les coupe pas les premières.
 */
async function recentQuestions(limit = PREVIOUS_STEMS): Promise<{ topic: string; stem: string }[]> {
  const qcm = await q.all<{ exam_id: number; topic: string; stem: string }>(`SELECT exam_id, topic, stem FROM qcm_items ORDER BY exam_id DESC, idx LIMIT ?`, limit).catch(() => []);
  const open = await q.all<{ exam_id: number; concept: string | null; statement_html: string | null }>(
    `SELECT exam_id, concept, statement_html FROM exam_questions ORDER BY exam_id DESC, id LIMIT ?`, limit,
  ).catch(() => []);
  return [
    ...open.map((o) => ({ exam_id: Number(o.exam_id), open: 0, topic: o.concept ?? "", stem: openAsStem(o.concept, o.statement_html ?? "") })).filter((o) => o.stem),
    ...qcm.map((x) => ({ exam_id: Number(x.exam_id), open: 1, topic: x.topic, stem: x.stem })),
  ].sort((a, b) => b.exam_id - a.exam_id || a.open - b.open).slice(0, limit).map(({ topic, stem }) => ({ topic, stem }));
}

/**
 * Une question ouverte en énoncé comparable à un QCM : sa notion en tête (une borne de longueur
 * coupe le décor, jamais elle), puis l'énoncé en texte — sans l'encadré de section « FOR ALL
 * STUDENTS », ni balises, ni commandes LaTeX. Il ne sert qu'à reconnaître une reprise.
 */
function openAsStem(concept: string | null, tex: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { dropSectionCallouts } = require("@/lib/exam-latex") as typeof import("@/lib/exam-latex");
  const text = dropSectionCallouts(tex)
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/\\[a-zA-Z]+\*?/g, " ")
    .replace(/[{}$\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return concept ? `[question ouverte : ${concept}] ${text}` : text;
}

const DUP_SCHEMA = {
  type: "object",
  properties: {
    notions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          notion: { type: "string", description: "La notion du cours que la question teste, nommée comme le cours ; EXACTEMENT le même libellé pour deux questions sur la même notion." },
          angle: { type: "string", description: "Le fait, la condition, l'étude ou le calcul précis qu'elle teste ; le même libellé pour deux questions au même angle." },
          regle: { type: "string", description: "La règle ou la réponse logique exacte que la question vérifie, SANS le décor du scénario (ex. « option par défaut gardée = nudge, supprimée = pas un nudge ») ; EXACTEMENT le même libellé pour deux questions qui vérifient la même règle, même sous un décor différent." },
          programme: { type: "integer", description: "Le numéro (N…) de la notion du programme dont relève ce que la question teste (sa bonne réponse), pas son décor ; 0 si aucune ne convient ou sans liste." },
        },
        required: ["index", "notion", "angle", "regle", "programme"],
        additionalProperties: false,
      },
    },
    duplicates: {
      type: "array",
      items: {
        type: "object",
        properties: { first: { type: "integer" }, second: { type: "integer" }, reason: { type: "string" } },
        required: ["first", "second", "reason"],
        additionalProperties: false,
      },
    },
    // Reprises d'un examen précédent du cours (P…), signalées par le contrôle de fin d'examen.
    repeats: {
      type: "array",
      items: {
        type: "object",
        properties: { index: { type: "integer" }, previous: { type: "integer" } },
        required: ["index", "previous"],
        additionalProperties: false,
      },
    },
  },
  required: ["notions", "duplicates", "repeats"],
  additionalProperties: false,
} as const;

/**
 * Paires à soumettre nommément au contrôle des doublons, repérées sans modèle : même notion du
 * programme, réponses croisées (la bonne réponse de chacune est une option de l'autre — job 23 :
 * « la réalité partagée » et « la confiance », clé de l'une et distracteur de l'autre), bonnes
 * réponses qui affirment le même fait sous un autre libellé de notion (job 25 : Q10/Q15, Q17/Q20,
 * que `keyNotion` seul ne rapprochait pas), ou même passage source (job 28, finition v6 : Q1/Q7,
 * la même comparaison chiffrée interrogée une fois sur les chiffres, une fois sur ce qu'ils
 * illustrent — `strict`, car quand le programme a MOINS de notions que de questions, réutiliser un
 * même exemple sous deux angles peut rester inévitable). Au plus 30.
 */
export function suspectPairs(items: Pick<QcmItem, "options" | "correct" | "notion" | "focusSlot" | "sourceFact">[], strict = true): [number, number][] {
  const heads = items.map((it) => new Set(it.options.map((o) => optionHead(o, it.options)).filter((h): h is string => !!h)));
  const keys = items.map((it) => keyNotion(it));
  const props = items.map((it) => keyProposition(it));
  const out: [number, number][] = [];
  for (let i = 0; i < items.length && out.length < 30; i++) {
    for (let j = i + 1; j < items.length && out.length < 30; j++) {
      if (items[i].focusSlot && items[j].focusSlot) continue;
      const sameNotion = !!items[i].notion && !!items[j].notion && notionBase(items[i].notion!) === notionBase(items[j].notion!);
      // Croisées dans les deux sens : la même distinction posée d'un côté puis de l'autre.
      const crossed = !!keys[i] && !!keys[j] && heads[j].has(keys[i]!) && heads[i].has(keys[j]!);
      const sameFact = !!props[i] && !!props[j] && sameProposition(props[i]!, props[j]!);
      const sameSource = strict && sameSourceFact(items[i].sourceFact, items[j].sourceFact);
      if (sameNotion || crossed || sameFact || sameSource) out.push([i, j]);
    }
  }
  return out;
}

/** Doublons d'un examen : les QCM à retirer (`intra` : doublons dans l'examen), les reprises d'un examen précédent, et la notion, l'angle et la règle de chacun. */
type DupResult = { drop: number[]; intra: number[]; repeats: number[]; notions: string[]; angles: string[]; regles: string[]; programme: (string | null)[] };
type DupAnswer = { notions?: { index: number; notion: string; angle: string; regle?: string; programme?: number }[]; duplicates: { first: number; second: number }[]; repeats?: { index: number; previous: number }[] };

/**
 * Consignes du contrôle des doublons. `strict` (au moins autant de notions au programme que de
 * questions, examen 4 de HUM-285 : biais de négativité ×3, nudge ×2…) : UNE NOTION = UNE QUESTION,
 * quel que soit l'angle. Sinon (plus de questions que de notions, ou un accent demandé) : plusieurs
 * questions sur une notion sous des angles vraiment distincts ; seul le même angle est un doublon.
 * Le modèle nomme la notion et l'angle de chaque question ; la décision, elle, est faite ici
 * (decideDuplicates). Job 23 (14/11) : trois questions dont la réponse était « le biais de
 * disponibilité » sont passées, le contrôle ne sachant pas quelle option était la bonne : il voit
 * la RÉPONSE LOGIQUE, et les paires suspectes repérées sans modèle lui sont soumises nommément.
 */
function duplicateRules(items: QcmItem[], opts: { strict: boolean; previous?: string[]; programme?: string[] }): string[] {
  const suspects = suspectPairs(items, opts.strict);
  const criterion = opts.strict
    ? `Le programme a au moins autant de notions que l'examen a de questions : UNE NOTION = UNE QUESTION. Deux questions sur la même notion (le biais de négativité, le nudge, la souveraineté des données…) sont des doublons même sous deux angles différents : liste-les en paire. Un même libellé large (une notion-parapluie qui regroupe plusieurs notions du programme) ne fait pas à lui seul un doublon : deux questions rangées dessous qui testent des notions du programme ou des règles distinctes restent toutes les deux. Deux questions qui s'appuient sur le MÊME exemple ou la MÊME étude du cours (même passage précis, même fait concret cité) sont aussi des doublons, même si l'une en demande les chiffres et l'autre ce qu'ils illustrent (finition v6, job 28 : la même comparaison chiffrée d'un grand quotidien et d'une encyclopédie collaborative) — ce n'est jamais un angle distinct, seulement l'habillage de la question qui change.`
    : `L'examen a plus de questions que le programme n'a de notions : deux questions sur une même notion sont permises si elles testent des angles VRAIMENT distincts (un autre fait, une autre condition, une autre étude) ; sont des doublons celles qui testent le même fait, la même condition, le même scénario ou le même raisonnement, même si l'une transforme la réponse de l'autre en distracteur ou reformule la question. Un décor différent (livraison de repas, e-commerce…) habillant la MÊME règle, avec la même réponse logique, reste un doublon : seul le FOND compte, jamais l'habillage. Reprendre le même exemple ou la même étude sous un angle vraiment distinct reste permis ici : le programme n'a pas assez de notions pour l'exclure.`;
  return [
    `Pour chaque QCM, nomme la notion du cours qu'il teste (notion, le MÊME libellé exact pour deux questions sur la même notion, même formulées autrement ou dans deux langues), l'angle précis (angle), et la règle ou réponse logique exacte qu'il vérifie SANS le décor du scénario (regle, le MÊME libellé exact si deux questions vérifient la même règle sous un décor différent).`,
    criterion,
    `Puis liste les paires en doublon selon ce critère. Compare d'abord les BONNES RÉPONSES : deux questions dont la bonne réponse est la même notion, ou qui se réussissent par le même raisonnement (la même règle, la même distinction posée dans un sens puis dans l'autre), sont des doublons ; partager des distracteurs ne suffit pas. Compare aussi l'énoncé, les options, le fait source et l'explication : recycler le même cas ou le même fait dans une autre option reste un doublon, de même que deux scénarios différents qui vérifient la même règle (regle identique). Deux notions voisines mais distinctes ne sont pas un doublon.`,
    // `suspects` couvre aussi la même PROPOSITION de la clé (texte de la bonne option + fait
    // source, lib/qcm-checks.keyProposition) — finition v5, Q7/Q14 : deux énoncés sans rien en
    // commun en apparence (un wiki, un forum d'entraide) mais la même clé en substance (« le
    // succès du modèle bénévole… motivations non financières ») et deux notions différentes.
    // Le nommer explicitement évite que deux libellés de notion distincts masquent le doublon.
    // Elle couvre aussi, en mode strict, le même PASSAGE SOURCE (lib/qcm-checks.sameSourceFact,
    // job 28 : Q1/Q7 sur le même exemple chiffré, chiffres d'un côté, interprétation de l'autre).
    ...(suspects.length ? [`Paires à trancher en priorité (même notion du programme, réponses croisées, bonne réponse + fait source qui affirment la même chose même sous un énoncé ou une notion différente, OU même exemple/étude source), à lister en doublon si elles testent la même chose : ${suspects.map(([a, b]) => `Q${a}–Q${b}`).join(", ")}.`] : []),
    // Banc du 04/11 (CS-290) : 2 questions sur 15 reprenaient un examen précédent du cours ; le
    // concepteur les voit, mais seul ce contrôle peut les retirer.
    ...(opts.previous?.length ? [`Liste aussi, dans "repeats", les QCM qui reprennent une question des EXAMENS PRÉCÉDENTS du cours (P…) : même fait, même règle ou même réponse logique, même si la notion, l'angle ou le décor sont reformulés.`] : []),
    // Examen #16, Q8 : une définition d'une autre notion, étiquetée sous la notion où son fait avait
    // été rangé à l'extraction. La revue dit de quelle notion du programme relève chaque question.
    ...(opts.programme?.length ? [`Pour chaque QCM, "programme" : le numéro (N…) de la notion du PROGRAMME ci-dessous dont relève ce qu'il teste — sa bonne réponse, jamais son décor ni l'étiquette entre parenthèses ; 0 si aucune ne convient.`, `NOTIONS DU PROGRAMME :`, ...opts.programme.map((l, i) => `N${i + 1}. ${sanitizeCorpus(l).slice(0, 100)}`)] : []),
  ];
}

/** Doublons décidés à partir des libellés et des paires rendus par le modèle : le premier de chaque notion reste. */
function decideDuplicates(items: QcmItem[], r: DupAnswer, opts: { strict: boolean; previousExams?: number; programme?: string[] }): DupResult {
  const notions = items.map(() => "");
  const angles = items.map(() => "");
  const regles = items.map(() => "");
  const programme: (string | null)[] = items.map(() => null);
  for (const n of r.notions ?? []) {
    if (!Number.isInteger(n?.index) || n.index < 0 || n.index >= items.length) continue;
    notions[n.index] = typeof n.notion === "string" ? n.notion.trim() : "";
    angles[n.index] = typeof n.angle === "string" ? n.angle.trim() : "";
    regles[n.index] = typeof n.regle === "string" ? n.regle.trim() : "";
    programme[n.index] = Number.isInteger(n.programme) && n.programme! >= 1 ? opts.programme?.[n.programme! - 1] ?? null : null;
  }
  // `drop` : doublons À L'INTÉRIEUR de l'examen ; les reprises d'un examen précédent (`repeats`)
  // sont rendues à part, l'appelant ne les retire que s'il a de quoi les remplacer.
  const drop = new Set<number>();
  const repeats = new Set<number>();
  for (const rp of Array.isArray(r.repeats) ? r.repeats : []) if (Number.isInteger(rp?.index) && rp.index >= 0 && rp.index < items.length) {
    // « Reprise » d'une question déjà retenue dans CET examen (P… au-delà des examens précédents) : un doublon dans l'examen.
    if (opts.previousExams !== undefined && Number.isInteger(rp.previous) && rp.previous >= opts.previousExams) drop.add(rp.index);
    else repeats.add(rp.index);
  }
  // Les questions de l'accent demandé par l'étudiant portent volontairement sur un même thème :
  // elles ne sont pas des doublons ENTRE ELLES (une autre question sur ce thème, si).
  const focusPair = (a: number, b: number) => !!items[a]?.focusSlot && !!items[b]?.focusSlot;
  // Par libellé (hors mode strict) : la première question d'une notion et d'un angle reste. En mode
  // strict, le libellé libre du modèle ne décide rien (PR #94 : une notion-parapluie retirait des
  // questions sur des notions planifiées distinctes, régénérées en boucle jusqu'au budget) ; une
  // notion = une question tient par le plafond sur la notion planifiée et par les paires signalées.
  if (!opts.strict) {
    const first = new Map<string, number>();
    items.forEach((_, i) => {
      if (!notions[i] || !angles[i]) return;
      const key = `${normalize(notions[i])}\u0000${normalize(angles[i])}`;
      const holder = first.get(key);
      if (holder === undefined) first.set(key, i);
      else if (!focusPair(holder, i)) drop.add(i);
    });
    // Même règle logique sous un décor différent (livraison de repas / e-commerce…) : un doublon
    // même si l'angle (le décor) diffère.
    const firstByRule = new Map<string, number>();
    items.forEach((_, i) => {
      if (!notions[i] || !regles[i]) return;
      const key = `${normalize(notions[i])}\u0000${normalize(regles[i])}`;
      const holder = firstByRule.get(key);
      if (holder === undefined) firstByRule.set(key, i);
      else if (!focusPair(holder, i)) drop.add(i);
    });
  }
  // Les paires que le modèle signale en plus (sans libellé, ou libellés différents) : la seconde part.
  for (const d of r.duplicates) {
    const later = Math.max(d.first, d.second);
    if (Number.isInteger(later) && later >= 0 && later < items.length && d.first !== d.second && !focusPair(d.first, d.second)) drop.add(later);
  }
  const intra = [...drop].sort((a, b) => a - b);
  return { drop: [...new Set([...intra, ...repeats])].sort((a, b) => a - b), intra, repeats: [...repeats].sort((a, b) => a - b), notions, angles, regles, programme };
}

const REVIEW_SCHEMA = {
  type: "object",
  properties: { verdicts: FINAL_QUALITY_SCHEMA.properties.verdicts, ...DUP_SCHEMA.properties },
  required: ["verdicts", "notions", "duplicates", "repeats"],
  additionalProperties: false,
} as const;

/**
 * REVUE FINALE EN UN APPEL — l'audit de sortie (clé, hors cours, distracteurs, calqué sur la
 * rubrique du banc) et le contrôle des doublons lisaient la même liste en deux appels, l'audit
 * repassant après chaque réparation (banc HUM-285 du 15/11, job 14 : deux audits de 96 000 et
 * 24 000 caractères puis un contrôle des doublons de 28 000). Une seule revue voit désormais
 * chaque question en entier, sa clé, son explication et le fait qui la prouve. Au job 16 de
 * HUM-285, la réponse d'un jeu de rôle devenait le distracteur d'une seconde question : l'énoncé
 * seul ne suffit pas à repérer deux questions qui exploitent le même fait.
 * Rend, par question, sa version auditée ou null (écartée : clé fausse ou hors cours) — `audit`
 * vaut null si la revue est illisible, et les verdicts de la vérification à l'aveugle tiennent —,
 * et les doublons, null si le contrôle est indisponible : les plafonds par notion s'appliquent seuls.
 */
async function finalReview(items: QcmItem[], opts: { strict: boolean; previous?: string[]; current?: string[]; step: StepCb; facts?: CourseFact[]; programme?: string[] }): Promise<{ audit: (QcmItem | null)[] | null; dup: DupResult | null }> {
  if (!items.length) return { audit: [], dup: null };
  // #113 : cases de justification encore vides (raison oubliée par la conception, effacée par le
  // filet ou non rendue par un remplacement), écrites dans cet appel qui passe de toute façon sur
  // chaque candidat : aucun appel de plus.
  const wants = items.map((it) => {
    const c = it.rationale ? rationaleCheck(it.rationale, it.options.length, it.correct) : null;
    return c && !c.ok ? { key: !c.key, options: c.missing } : null;
  });
  const toJustify = wants.filter(Boolean).length;
  const topicPassages = await coursePassages([...new Set(items.map((it) => it.topic).filter(Boolean))]).catch(() => []);
  // Une question bâtie sur un fait du cours (lib/qcm-facts) a sa preuve dans le passage de ce fait,
  // souvent hors des deux extraits de sa notion : sans lui, l'audit la jugeait hors cours (banc
  // HUM-285 du 16/11 : 32 candidats sur 55, contre 7 à 10 conçus par notion, et un complément final
  // de 7 questions). Le texte du cours qui porte ce passage, cherché dans le corpus, l'accompagne.
  const facts = opts.facts ?? [];
  const proofs = [...new Set(items.flatMap((it) => facts.filter((f) => f.id === it.factId).map((f) => f.passage)))];
  const factPassages = proofs.length ? await coursePassages(proofs, 1, 600).catch(() => []) : [];
  const passages = [...topicPassages, ...factPassages.filter((p) => !topicPassages.some((x) => x.text === p.text))];
  const body = items.map((it, index) => [
    `Q${index}. (${sanitizeCorpus(it.topic ?? "").slice(0, 80)}) ${sanitizeCorpus(it.stem)}`,
    ...it.options.map((o, k) => `   (${k}) ${sanitizeCorpus(o)}${wants[index]?.options.includes(k) ? "  ← À JUSTIFIER (pourquoi elle est fausse)" : ""}`),
    `   CLÉ : ${it.correct.join(", ")}${wants[index]?.key ? "  ← À JUSTIFIER (key)" : ""}`,
    `   EXPLICATION : ${sanitizeCorpus(it.explanation ?? "")}`,
    `   FAIT SOURCE : ${sanitizeCorpus(it.sourceFact ?? "").slice(0, 300)}`,
  ].join("\n")).join("\n\n");
  // Examens précédents (bornés) PUIS questions déjà retenues dans cet examen : ces dernières ne
  // sont jamais coupées par la borne, et une reprise de l'une d'elles est un doublon (decideDuplicates).
  const previousExams = Math.min(opts.previous?.length ?? 0, PREVIOUS_STEMS);
  const prior = [...(opts.previous ?? []).slice(0, PREVIOUS_STEMS), ...(opts.current ?? [])];
  const previous = prior.map((stem, i) => `P${i}. ${sanitizeCorpus(stem).slice(0, 220)}`).join("\n");
  const programme = (opts.programme ?? []).slice(0, 60);
  const schema = toJustify
    ? { ...REVIEW_SCHEMA, properties: { ...REVIEW_SCHEMA.properties, justifications: AUDIT_JUSTIFICATIONS }, required: [...REVIEW_SCHEMA.required, "justifications"] }
    : REVIEW_SCHEMA;
  const out = await completeJson<{ verdicts: FinalQualityVerdict[]; justifications?: { index: number; key?: string; distractors?: { option_index: number; why_wrong: string }[] }[] } & DupAnswer>({
    model: "opus", ...QCM_CALL_LIMITS, json: { schema },
    prompt: [
      `Tu es un examinateur exigeant. Voici les QCM d'un même examen, avec leur clé, leur explication et le fait du cours qui les prouve. Deux contrôles, rendus dans le même objet JSON.`,
      `1. AUDIT (verdicts) : pour chaque QCM, tranche selon les extraits du cours.`,
      ...AUDIT_RULES,
      ...(toJustify ? [`justifications : pour chaque QCM qui a des cases « ← À JUSTIFIER », une entrée {index, key, distractors} — "key" (seulement si la clé est marquée, sinon vide) dit pourquoi elle est juste selon le cours ; "distractors" a une entrée par option marquée, et elles seules : "option_index" son numéro, "why_wrong" pourquoi CETTE option est fausse (le détail du cours qu'elle contredit), sans citer d'autre option, ni lettre, ni numéro.`] : []),
      `2. DOUBLONS (notions, duplicates, repeats).`,
      ...duplicateRules(items, { strict: opts.strict, previous: prior, programme }),
      DATA_RULE, passages.length ? dataBlock("EXTRAITS DU COURS", passages) : "", "", body,
      ...(previous ? ["", `QUESTIONS DES EXAMENS PRÉCÉDENTS :`, previous] : []),
      "",
      `Réponds UNIQUEMENT avec {"verdicts": [{"index": 0, "key": true, "offCourse": false, "trivial": []}], "notions": [{"index": i, "notion": "…", "angle": "…", "regle": "…", "programme": n}], "duplicates": [{"first": i, "second": j, "reason": "…"}], "repeats": [{"index": i, "previous": p}]${toJustify ? `, "justifications": [{"index": 0, "key": "", "distractors": [{"option_index": 1, "why_wrong": "…"}]}]` : ""}} : un verdict et une notion par QCM, first < second, listes vides s'il n'y a rien.`,
    ].join("\n"),
  }, { check: (v) => verdictsCheck(v, items.length) ?? (Array.isArray(v?.duplicates) ? null : "le champ « duplicates » (tableau) manque") }).catch((e) => {
    opts.step(`Revue finale en échec (${llmFailureReason(e).split(/\.\s/u)[0].slice(0, 80)}) : verdicts de la vérification gardés, plafonds par notion appliqués seuls`, 79);
    return null;
  });
  if (!out) return { audit: null, dup: null };
  let justified = 0;
  if (toJustify) {
    const given = new Map((Array.isArray(out.justifications) ? out.justifications : []).filter((x) => Number.isInteger(x?.index)).map((x) => [x.index, x]));
    items.forEach((it, i) => {
      const want = wants[i];
      if (!want || !it.rationale) return;
      it.rationale = cleanRationale(fillRationale(it.rationale, given.get(i), want, it.options.length, it.correct), it.options, it.correct, it.stem);
      syncExplanation(it);
      if (rationaleCheck(it.rationale, it.options.length, it.correct).ok) justified++;
    });
  }
  opts.step(`Revue finale : clés, hors-cours, distracteurs et doublons contrôlés en un appel${toJustify ? ` (${justified}/${toJustify} justification(s) complétée(s) au passage)` : ""}`, 79);
  const byIndex = new Map((out.verdicts ?? []).map((v) => [v.index, v]));
  const audit = items.map((it, i) => applyFinalQualityVerdicts([it], byIndex.has(i) ? [{ ...byIndex.get(i)!, index: 0 }] : [])[0] ?? null);
  return { audit, dup: decideDuplicates(items, out, { strict: opts.strict, previousExams, programme }) };
}

/**
 * Budget TEMPS de la phase finale (après la revue : comblement, réparation, porte de sortie) :
 * QCM_FINAL_PHASE_BUDGET_MS, défaut 6 min (10 min jusqu'au job 28, finition v6 : examen livré en
 * 42 min, phase finale à 14 min pour une seule ronde de réparation). Job 26 (15/11/2026) : à 99 %
 * dès 30 min, puis 40 min de plus sur « un distracteur reste éliminable sans le cours », ronde après
 * ronde de remplacement (conception → vérification → réparation → revérification, jusqu'à 10 min
 * d'appel chacune depuis #95) ; seul un budget de lots (10 pour 20 QCM) bornait la boucle. Une
 * ronde réelle dure 5 à 7 min : 6 min laissent encore un remplacement et la porte de sortie, sans
 * les 3 à 4 min de marge inutilisées que laissait l'ancien budget de 10. Le budget n'interrompt
 * aucun appel : il empêche d'en lancer une nouvelle ronde ; à épuisement, seuls les contrôles déterministes de la porte de sortie passent encore, ses appels au modèle (revérification,
 * réécriture des explications) cèdent la place (#105) sans jamais garder une question non vérifiée.
 */
const FINAL_PHASE_DEFAULT_MS = 6 * 60_000;
function finalPhaseBudgetMs(): number {
  const n = Number(process.env.QCM_FINAL_PHASE_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? n : FINAL_PHASE_DEFAULT_MS;
}

/**
 * Notions distinctes d'une liste de libellés (variantes rapprochées, lib/coverage) : c'est elle,
 * pas le nombre de lignes ni les titres de supports ajoutés faute de notions, qui dit si l'examen
 * a assez de notions pour une question chacune.
 */
function distinctNotions(labels: string[]): number {
  const reps: string[] = [];
  for (const l of labels) if (!reps.some((r) => variants(r, l))) reps.push(l);
  return reps.length;
}

/**
 * Lots QCM menés en même temps (QCM_BATCH_CONCURRENCY, défaut 8 = le plafond). Banc moteur du
 * 04/11/2026 (CS-290, 15 QCM = 4 lots) : à 3, le 4e lot attendait les trois premiers, 7 min de plus
 * en série ; le limiteur global des appels (LLM_MAX_CONCURRENCY) borne déjà la charge.
 */
function batchConcurrency(): number {
  const n = Number(process.env.QCM_BATCH_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 8) : 8;
}

/** Questions ouvertes construites en même temps (QCM_OPEN_CONCURRENCY, défaut 3). */
function openConcurrency(): number {
  const n = Number(process.env.QCM_OPEN_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 8) : 3;
}

/** `fn` sur chaque élément, `n` à la fois au plus. */
export async function runPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}


/** `requested` / `openRequested` : la composition demandée — `count` / `open` peuvent rester en dessous. */
export type QcmExamResult = { id: number; count: number; requested: number; verified: number; open: number; openRequested: number; pdf?: string; texError?: string };

/**
 * Questions conçues en plus de l'examen (15 %, au moins une), sur des notions de réserve : une
 * question écartée par la vérification ou la revue finale est remplacée sans nouvelle conception.
 * Banc HUM-285 du 15/11 : une clé contestée sur vingt, quand une ronde de comblement coûte au
 * moins trois appels (conception, vérification, revue).
 */
function spareMargin(count: number): number {
  return count > 0 ? Math.ceil(count * 0.15) : 0;
}

/**
 * Durée de chaque phase d'un examen QCM sans historique (banc de M : ~10 min à
 * LLM_MAX_CONCURRENCY=4, QCM et ouvertes en parallèle) ; sinon la médiane des journaux
 * des derniers jobs du cours (lib/jobs phaseHistory). Mêmes noms que les lignes « ⏱ ».
 */
const DEFAULT_PHASE_MS: Record<string, number> = { QCM: 6 * 60_000, "Questions ouvertes": 6 * 60_000, PDF: 30_000 };

/**
 * RÉPARTITION D'UN EXAMEN QCM : sujets des QCM, moules, et réserve de notions pour remplacer une
 * question écartée. Calculée une fois par examen ; une reprise réutilise celle de son point de
 * reprise (lib/qcm-checkpoint) : recalculée, elle éviterait les questions déjà enregistrées.
 */
async function planQcmExam({ count, openCount, focus, nFocus, needed, dna, step, language }: { count: number; openCount: number; focus?: string; nFocus: number; needed: number; dna: ExamDna | null; step: StepCb; language?: string }): Promise<QcmPlan> {
  let covAll: CovTopic[] = await coverageTopics();
  // Notions réelles du programme, avant l'ajout des titres de supports (mode strict, plus bas).
  const notionCount = distinctNotions(covAll.map((t) => t.label));
  // FAITS TESTABLES du programme (lib/qcm-facts), gardés en base d'un examen à l'autre.
  const facts = qcmFactsEnabled() && needed >= FACTS_MIN_QUESTIONS && covAll.length ? await planFactsOf(covAll.map((t) => t.label), count, step, language) : [];
  // Moins de notions que de questions (cours sans annale, 10 notions pour 20 QCM) : on les
  // parcourait deux fois, d'où des doublons et un déséquilibre entre enseignants (banc HUM-285
  // du 28/10). Les supports du cours complètent la couverture.
  if (covAll.length < needed) {
    const known = new Set(covAll.map((t) => t.label.toLowerCase()));
    for (const title of await courseMaterialTitles()) {
      if (!known.has(title.toLowerCase())) covAll = [...covAll, { label: title, method: null }];
    }
  }
  // RÉPARTITION SUR LES CHAPITRES (plan du cours, sinon supports) au prorata de leur poids, QCM
  // puis ouvertes : CS-290 (02/11) n'avait que Fairness 1, en tête par poids. Sans au moins deux
  // chapitres, thèmes DISTINCTS par poids (pickCoverage), la reprise étant marquée plus bas.
  // H — notions des examens précédents de CE cours (même utilisateur : base du tenant) reprises
  // en dernier ; quelques notions de RÉSERVE en plus, pour remplacer un doublon retiré.
  const recent = await recentQuestions();
  // 8 : l'examen 4 de HUM-285 avait cinq questions en trop sur des notions déjà posées.
  const SPARE = 8;
  const spread = spreadOverChapters(
    await assignChapters(covAll.map((t) => ({ ...t, weight: t.weight ?? 0 })), { fillChapters: true }).catch(() => []),
    needed + openCount + SPARE,
    { avoid: recent.map((r) => r.topic), asked: recent.map((r) => r.stem) },
  );
  // Sous-thème nommé (une facette de la notion pas encore posée) : il remplace la consigne de reprise.
  const spreadCov: QcmSlot[] = spread
    ? spread.map((t) => ({ label: t.label, method: t.repeat && !t.subTheme ? REPEAT_METHOD : t.method, subTheme: t.subTheme ?? null }))
    : pickCoverage(covAll, Math.min(needed, covAll.length)).map((t) => ({ label: t.label, method: t.method }));
  // PLAFOND PAR NOTION (job 23, 14/11 : cinq questions sur « Désinformation générative »,
  // quatre sur « Système 1 / Système 2 », pour dix notions et vingt questions) : une question par
  // notion quand le programme en a assez, sinon deux, sous des angles vraiment distincts ; et une
  // seule question par notion de bonne réponse. Le plan le respecte dès la conception : les sujets
  // au-delà du plafond passent après les autres (ouvertes et réserve).
  const caps = { perNotion: notionCap(notionCount, count), perKey: 1 };
  const planned = new Map<string, number>();
  const withinCap = spreadCov.filter((t) => {
    const n = planned.get(notionBase(t.label)) ?? 0;
    planned.set(notionBase(t.label), n + 1);
    return n < caps.perNotion;
  });
  const cov: QcmSlot[] = [...withinCap, ...spreadCov.filter((t) => !withinCap.includes(t))];
  const qcmTopics: QcmSlot[] = [];
  for (let i = 0; i < count; i++) {
    if (i < nFocus) { qcmTopics.push({ label: focus!, method: FOCUS_METHOD }); continue; }
    const k = i - nFocus;
    const t = cov[k % cov.length];
    // Un thème repris (plus de questions que de thèmes) doit tester un AUTRE fait.
    qcmTopics.push(spread || k < cov.length ? t : { label: t.label, method: REPEAT_METHOD });
  }
  // Réserve : les notions que la répartition n'a données ni aux QCM ni aux ouvertes ; sans
  // répartition, les notions non prises, puis les autres en reprise (un AUTRE fait).
  const used = new Set(qcmTopics.map((t) => t.label));
  const spareTopics = spread
    ? cov.slice(needed + openCount)
    : [...covAll.filter((t) => !used.has(t.label)), ...covAll.map((t) => ({ label: t.label, method: REPEAT_METHOD }))];
  const qcmMolds = sampleMolds(dna, count);
  // UN FAIT PAR QUESTION : les questions (hors accent demandé) reçoivent chacune un fait distinct,
  // le maximum de notions d'abord, dans l'ordre de la répartition (chapitres, notions déjà posées en
  // dernier), au plus `caps.perNotion` par notion ; la réserve garde les autres faits. Trop peu de
  // faits pour l'examen : la conception par notion, comme avant.
  if (facts.length) {
    const asked = await askedFacts(facts);
    const { picked, reserve } = planFacts(facts, { order: [...spreadCov.map((t) => t.label), ...covAll.map((t) => t.label)], count: needed, cap: caps.perNotion, asked });
    // hum-285 (17/11) : 18 faits pour 20 questions faisaient repasser TOUT l'examen par notion
    // (11 paires de doublons à la revue, 15/20 livrées). Assez de faits pour un examen par faits :
    // chacun sert, et seules les places sans fait sont conçues par notion — les notions les moins
    // servies d'abord, sous le plafond, un AUTRE fait que ceux de l'examen.
    if (picked.length >= Math.min(needed, FACTS_MIN_QUESTIONS)) {
      const methodOf = (label: string) => covAll.find((t) => notionBase(t.label) === notionBase(label))?.method ?? null;
      const slot = (f: CourseFact): QcmSlot => ({ label: f.notion, method: methodOf(f.notion), fact: f });
      const byNotion = notionSlotsBeside(picked, [...spreadCov, ...covAll], needed - picked.length, caps.perNotion);
      const fresh = picked.filter((f) => !asked.has(f.id)).length;
      step(`Faits testables : ${picked.length} faits distincts sur ${new Set(picked.map((f) => notionBase(f.notion))).size} notions (${fresh} jamais posés), ${reserve.length} en réserve${byNotion.length ? `, ${byNotion.length} question(s) conçue(s) par notion faute de faits` : ""}`, 8);
      return {
        notionCount, recent, spread: !!spread, covAll, cov, qcmMolds, facts, askedFacts: [...asked.keys()],
        qcmTopics: [...qcmTopics.slice(0, nFocus), ...picked.map(slot), ...byNotion],
        spareTopics: reserve.map(slot),
      };
    }
    step(`Faits testables : ${picked.length} pour ${needed} questions, trop peu → conception par notion`, 8);
  }
  return { notionCount, recent, spread: !!spread, covAll, cov, qcmTopics, spareTopics, qcmMolds };
}

/**
 * Places d'un examen par faits que les faits ne couvrent pas : `n` sujets par notion, les notions
 * sans fait retenu d'abord (dans l'ordre de la répartition), puis les moins servies, sous `cap`
 * questions par notion. Une notion qui a déjà un fait est reprise pour un AUTRE fait.
 */
function notionSlotsBeside(picked: CourseFact[], order: { label: string; method: string | null }[], n: number, cap: number): QcmSlot[] {
  const counts = new Map<string, number>();
  for (const f of picked) counts.set(notionBase(f.notion), (counts.get(notionBase(f.notion)) ?? 0) + 1);
  const notions = [...new Map(order.filter((t) => t.method !== FOCUS_METHOD).map((t) => [notionBase(t.label), t])).values()];
  const out: QcmSlot[] = [];
  for (let grew = true; out.length < n && grew;) {
    grew = false;
    for (const t of [...notions].sort((a, b) => (counts.get(notionBase(a.label)) ?? 0) - (counts.get(notionBase(b.label)) ?? 0))) {
      if (out.length >= n) break;
      const k = counts.get(notionBase(t.label)) ?? 0;
      if (k >= cap) continue;
      counts.set(notionBase(t.label), k + 1);
      grew = true;
      out.push(k === 0 ? { label: t.label, method: t.method === REPEAT_METHOD ? null : t.method } : { label: t.label, method: REPEAT_METHOD });
    }
  }
  return out;
}

/** Questions (hors accent demandé) à partir desquelles l'examen se conçoit par faits testables. */
const FACTS_MIN_QUESTIONS = 6;

/** Faits testables activés (QCM_FACTS=0 les coupe : conception par notion, comme avant). */
function qcmFactsEnabled(): boolean {
  return process.env.QCM_FACTS !== "0";
}

/** Les faits du programme, ou aucun si l'extraction échoue (l'examen se conçoit alors par notion). */
async function planFactsOf(labels: string[], count: number, step: StepCb, language?: string): Promise<CourseFact[]> {
  const t0 = Date.now();
  try {
    const r = await courseFacts(labels, { count, step, language });
    if (!r.cached) step(phaseLine("Faits testables", Date.now() - t0), 8);
    if (!r.facts.length && r.calls) step(`Faits testables : extraction sans résultat → conception par notion`, 8);
    return r.facts;
  } catch (e) {
    step(`Faits testables indisponibles (${llmFailureReason(e).slice(0, 80)}) → conception par notion`, 8);
    return [];
  }
}

/** Génère un examen QCM complet (N QCM + M ouvertes), vérifié, persisté, rendu en PDF.
 *  `count`/`openCount` : la COMPOSITION choisie par l'utilisateur (composeur). `focus` : « Mets l'accent
 *  sur… » (générique) — garantit ~2 QCM sur le thème sans monopoliser (count ≤ 2 → entièrement ciblé). */
export async function generateQcmExam(opts: { count?: number; openCount?: number; focus?: string; onStep?: StepCb; onExamReady?: (examId: number, order: { requested: number }) => void | Promise<void>; phaseMs?: Record<string, number>; checkpoint?: QcmCheckpointStore } = {}): Promise<QcmExamResult> {
  await ensureQcmSchema();
  const report = opts.onStep ?? (() => {});
  // TEMPS RESTANT — avancement PAR PHASE (lib/progress) dès que les lots sont connus : les
  // pourcentages des étapes sont ignorés. Lots et ouvertes en parallèle publiaient chacun les
  // leurs (82 %, puis 30 %, puis 70 %) et le journal 0 % : le temps restant remontait.
  let work: PhaseProgress | null = null;
  const step: StepCb = (m, p) => report(m, work ? work.pct() : Math.min(p, 8));
  // M — durée de chaque phase dans le journal du job (mesure avant/après).
  const tStart = Date.now();
  const logPhase = (label: string, since: number) => step(phaseLine(label, Date.now() - since), 0);
  const focus = (opts.focus ?? "").trim() || undefined;
  // Format résolu : langue, mode de réponse et nombre d'options de l'examen ; sans annale, les
  // exemples officiels donnent le style (permis si les annales en ont le style).
  const format = await resolveExamFormat().catch(() => null);
  // count peut être 0 (drill « 0 QCM + 1 ouvert ») → on respecte le choix explicite ; sinon le plan
  // du format (lib/exam-format) : le nombre de l'annale, aucune ouverte inventée (audit 3, P0-4).
  // Un cours d'un autre format : le plan d'un QCM demandé pour cet examen (lib/exam-format).
  const coursePlan = format ? planMockExam(format, {}) : null;
  const mockPlan = coursePlan?.generator === "qcm" || !format ? coursePlan : planMockExam(requestedFormat(format, "qcm"), {});
  const count = Math.max(0, opts.count ?? (mockPlan?.generator === "qcm" ? mockPlan.qcmCount : QCM_DEFAULT));
  const openCount = Math.max(0, opts.openCount ?? (mockPlan?.generator === "qcm" ? mockPlan.openCount : 0));
  if (count === 0 && openCount === 0) throw new Error("Composition vide : choisis au moins 1 QCM ou 1 question ouverte.");
  // « Mets l'accent sur… » (focus générique) : garantit ~2 QCM sur le thème choisi SANS
  // monopoliser — le reste couvre le programme. Petit count (≤2) → entièrement ciblé (drill).
  // couverture LARGE (pickCoverage : tête + longue traîne) + MOULES échantillonnés
  // proportionnellement à l'ADN détecté du cours (sans ADN → null = comportement d'avant).
  const dna = await getExamDna().catch(() => null);
  const nFocus = focus ? Math.min(2, Math.max(1, count)) : 0;
  const needed = Math.max(1, count - nFocus);
  // POINT DE REPRISE (lib/qcm-checkpoint) : un job repris après une coupure repart de ce qui est
  // acquis. Absent, illisible ou d'une autre composition : départ à neuf, comme avant.
  const ckKey = qcmCheckpointKey({ count, openCount, focus });
  const ck = opts.checkpoint ? readQcmCheckpoint(await opts.checkpoint.load().catch(() => null), ckKey) : null;
  const plan = ck?.plan ?? await planQcmExam({ count, openCount, focus, nFocus, needed, dna, step, language: format?.language });
  const { notionCount, recent, covAll, cov, qcmTopics, spareTopics, qcmMolds } = plan;
  /** Examen conçu par faits testables : chaque question (hors accent) teste un fait distinct. */
  const factMode = !!plan.facts?.length && qcmTopics.some((t) => !!t.fact);
  /**
   * Notion du fait testable qu'une question teste (lib/qcm-facts), ou null. C'est l'étiquette
   * affichée : examen #15 (16/11, job 30), une question sur une notion précise portait l'étiquette
   * d'une autre notion du programme, le sujet que le concepteur avait recopié, pas la notion du fait
   * qu'elle teste ; les points faibles de l'étudiant se rangeaient sous la mauvaise notion.
   */
  const factNotion = (id: string | null | undefined): string | null => (factMode && id ? plan.facts?.find((f) => f.id === id)?.notion ?? null : null);
  /** Aligne la notion et l'étiquette affichée (topic) d'une question sur le fait qu'elle teste. */
  const labelFromFact = (it: QcmItem): void => {
    const n = it.focusSlot ? null : factNotion(it.factId);
    if (n) { it.notion = n; it.topic = n; }
  };
  const caps = { perNotion: notionCap(notionCount, count), perKey: 1 };
  /** Libellés des notions du programme : étiquettes possibles d'une question. */
  const programmeLabels = [...new Set([...cov, ...covAll].map((t) => t.label))];
  // Ouvertes : la suite de la répartition (les chapitres que les QCM n'ont pas pris d'abord).
  const openTopic = (i: number) => (plan.spread ? cov[(needed + i) % cov.length] : cov[(count + i) % cov.length]);
  const used = new Set(qcmTopics.map((t) => t.label));
  const withAnnales = format?.basis === "annales";
  const shared = {
    dna,
    language: format?.language,
    withAnnales,
    examTopics: qcmTopics.map((t) => t.label),
    previousStems: recent.map((r) => r.stem),
    studentFocus: focus,
    examples: withAnnales ? [] : await officialExamples().catch(() => []),
    // Avec annales, leur forme ; sinon le mode déclaré ou lu dans les sources, à défaut la réponse unique.
    answerMode: format?.answerMode ?? DEFAULT_ANSWER_MODE,
    optionsPerQuestion: format?.optionsPerQuestion ?? null,
    // Le résumé du format du cours seulement s'il est à choix : un QCM demandé pour un cours
    // d'exercices ou à questions composées ne doit pas lire « Format du cours : exercices ».
    formatSummary: format?.answerMode ? format.summary : undefined,
    examFacts: factMode ? qcmTopics.flatMap((t) => (t.fact ? [t.fact] : [])) : undefined,
    facts: factMode ? plan.facts : undefined,
  };
  step(`Architecte : ${count} QCM + ${openCount} ouverte(s)${focus ? ` (accent : « ${focus} »)` : ""}${dna ? ` · moules ADN (${dna.molds.length})` : " au format détecté"}…`, 8);

  // SUR-GÉNÉRER PUIS FILTRER — banc HUM-285 du 15/11 (job 14, 20 QCM livrés en 64 appels) : lots de
  // 4, vérification par paquets de 8, réparation puis revérification à chaque ronde, jusqu'à trois
  // rondes de comblement lancées alors qu'aucune question ne manquait (budget de distracteurs
  // triviaux dépassé), puis audit, réparation, ré-audit et contrôle des doublons en appels séparés.
  // Ici, au nominal, six appels pour 20 QCM : trois lots de 8 conçus en parallèle avec une petite
  // marge de notions de réserve (une question écartée est remplacée sans nouvelle conception), UNE
  // vérification groupée, UNE réparation des distracteurs de la sélection et UNE revue finale
  // (audit et doublons). Une seule ronde de comblement, et seulement s'il manque des questions.
  const BATCH = 8;
  type Batch = QcmBatchState;
  type Slot = { topic: QcmSlot; mold: MoldKind | null };
  /** Une vérification ou une réparation groupée porte au plus GROUP questions : un appel pour un examen de 20 QCM. */
  const GROUP = 24;
  const chunked = <T,>(xs: T[]): T[][] => Array.from({ length: Math.ceil(xs.length / GROUP) }, (_, k) => xs.slice(k * GROUP, (k + 1) * GROUP));
  /** verifyQcmBatch écrit ses verdicts SUR les items reçus (verified, rejected…) : rien à réassembler. */
  const verifyGrouped = async (items: QcmItem[]): Promise<void> => { await Promise.all(chunked(items).map((c) => verifyQcmBatch(c, step))); };
  /** `slots` en lots équilibrés d'au plus BATCH questions (23 → 7, 8, 8). */
  const toLots = (slots: Slot[], guidance?: string): Batch[] => {
    const n = Math.ceil(slots.length / BATCH);
    return Array.from({ length: n }, (_, k) => {
      const slice = slots.slice(Math.floor((k * slots.length) / n), Math.floor(((k + 1) * slots.length) / n));
      return { topics: slice.map((s) => s.topic), molds: slice.map((s) => s.mold), ...(guidance ? { guidance } : {}) };
    });
  };
  let lastError: unknown = null;
  /** Faits posés aux examens précédents du cours (plan) ; reprises gardées en réserve (plus bas). */
  const askedBefore = new Set(plan.askedFacts ?? []);
  /** QCM conçus puis écartés par les contrôles (rejet, distracteur trivial) : la cause d'un examen vide n'est pas alors une réponse illisible. */
  let qualityDropped = 0;
  const all: QcmItem[] = [];
  /** Candidats vérifiés déjà payés : l'examen en retient `count`, les autres remplacent une question écartée. */
  const verifiedCandidates: QcmItem[] = [];
  /** Écartés pour de bon : doublons (du modèle ou au-delà d'un plafond), reprises d'un examen précédent, clés refusées par la revue. */
  const auditDuplicates = new Set<string>();
  const historicalRepeats = new Set<string>();
  const auditRejected = new Set<string>();
  /**
   * REPRISES D'UN EXAMEN PRÉCÉDENT GARDÉES EN RÉSERVE — job 26 (15/11/2026, HUM-285, 11e examen du
   * cours) : 9 QCM livrés sur 20. Le contrôle range dans « repeats » toute question qui reprend le
   * même fait ou la même règle qu'une question des examens précédents, même reformulée ; sur un
   * cours dont chaque notion a déjà été posée plusieurs fois, c'est une bonne part de l'examen, et
   * ses remplaçants le sont à leur tour. Une reprise reste remplacée quand un remplaçant passe ;
   * sinon, déjà vérifiée et auditée, elle reprend sa place plutôt que de laisser un trou. Un
   * doublon DANS l'examen, lui, ne revient jamais.
   */
  const repeatFallback = new Map<string, QcmItem>();
  /** Reprises d'un fait déjà posé, mises de côté dès la vérification (vet) : pas encore revues. */
  const heldUnreviewed = new Map<string, QcmItem>();
  /** Doublons du seul modèle entre faits distincts (revue finale) : repris faute de remplaçant. */
  const softFallback = new Map<string, QcmItem>();
  /** Notion et angle de chaque question retenue, nommés par la revue finale : le comblement sait ce que l'examen pose déjà. */
  const reviewed = new Map<string, { notion: string; angle: string }>();
  // H — Une notion = une question tant que le programme a au moins autant de notions que l'examen a de
  // questions ; sinon plusieurs questions par notion, sous des angles vraiment distincts. Les
  // questions de l'accent demandé par l'étudiant partagent leur thème sans être des doublons.
  const strict = notionCount >= count;
  // RÉSERVE COMMUNE à la marge et au comblement : en mode strict, ni une
  // reprise ni une autre facette d'une notion déjà donnée à l'examen ; à défaut, les supports du
  // cours pas encore pris (ils ramènent d'autres passages). Chaque notion n'est servie qu'une fois.
  const fresh: QcmSlot[] = [
    ...spareTopics.filter((t) => t.method !== REPEAT_METHOD && !used.has(t.label)),
    ...(await courseMaterialTitles().catch(() => [] as string[])).filter((t) => !used.has(t)).map((label) => ({ label, method: null })),
  ];
  // Par faits : la réserve de faits, chacun donné une fois (un fait écarté ne revient pas).
  const pool: QcmSlot[] = factMode ? spareTopics : strict ? fresh.filter((t, i) => fresh.findIndex((x) => x.label === t.label) === i) : spareTopics;
  const usedFacts = new Set<string>(qcmTopics.flatMap((t) => (t.fact ? [t.fact.id] : [])));
  /** Questions de l'examen (hors accent demandé) par base de notion, `extra` (sujets déjà retenus) compris. */
  const notionCounts = (extra: QcmSlot[] = []): Map<string, { label: string; n: number }> => {
    const counts = new Map<string, { label: string; n: number }>();
    const add = (label: string) => {
      const b = notionBase(label);
      const c = counts.get(b) ?? { label, n: 0 };
      c.n++;
      counts.set(b, c);
    };
    for (const it of all) if (!it.focusSlot && (it.notion || it.topic)) add((it.notion || it.topic)!);
    for (const t of extra) add(t.label);
    return counts;
  };
  let nextSpare = 0;
  /** `n` notions de réserve, sans dépasser le plafond par notion de l'examen, `planned` (sujets prévus) compris. */
  const takeSpare = (n: number, planned: QcmSlot[] = []): QcmSlot[] => {
    const out: QcmSlot[] = [];
    if (factMode) {
      // Le premier fait encore jamais donné d'une notion sous son plafond : une notion dont la
      // question est partie retrouve un fait, les autres attendent leur tour.
      for (const t of pool) {
        if (out.length >= n) break;
        if (!t.fact || usedFacts.has(t.fact.id)) continue;
        if ((notionCounts([...planned, ...out]).get(notionBase(t.label))?.n ?? 0) >= caps.perNotion) continue;
        usedFacts.add(t.fact.id);
        out.push(t);
      }
      return out;
    }
    while (out.length < n && nextSpare < pool.length) {
      const t = pool[nextSpare++];
      if (strict && used.has(t.label)) continue;
      // Une notion déjà à son plafond dans l'examen ne reçoit pas une question de plus.
      if ((notionCounts([...planned, ...out]).get(notionBase(t.label))?.n ?? 0) >= caps.perNotion) continue;
      used.add(t.label);
      out.push(t);
    }
    return out;
  };
  /**
   * Sujets pour combler sans dépasser le plafond, les notions les moins posées d'abord : une notion
   * du programme encore sans question (sa question a été retirée) est redemandée telle quelle, une
   * notion déjà posée l'est sous un autre angle.
   */
  const repeatSlots = (n: number, extra: QcmSlot[]): QcmSlot[] => {
    const counts = notionCounts(extra);
    const programme = new Map<string, QcmSlot>();
    for (const t of [...cov, ...covAll.map((c) => ({ label: c.label, method: c.method }))]) if (t.method !== FOCUS_METHOD && !programme.has(notionBase(t.label))) programme.set(notionBase(t.label), t);
    for (const [b, t] of programme) if (!counts.has(b)) counts.set(b, { label: t.label, n: 0 });
    const order = [...counts.entries()].sort((a, b) => a[1].n - b[1].n);
    const out: QcmSlot[] = [];
    for (let grew = true; out.length < n && grew;) {
      grew = false;
      for (const [b, c] of order) {
        if (out.length >= n || c.n >= caps.perNotion) continue;
        const fresh = c.n === 0 ? programme.get(b) : undefined;
        c.n++;
        grew = true;
        out.push(fresh ? { label: fresh.label, method: fresh.method === REPEAT_METHOD ? null : fresh.method, subTheme: fresh.subTheme ?? null } : { label: c.label, method: REPEAT_METHOD });
      }
    }
    return out;
  };
  const hardStop = () => {
    const code = llmErrorCode(lastError);
    return !!code && HARD_STOP_CODES.has(code);
  };
  /**
   * selectWithinTrivialBudget sans franchir les plafonds par notion : un candidat qui les
   * dépasserait (notion du programme, notion de la bonne réponse) est écarté et la sélection refaite.
   * Les questions déjà retenues (`current`) passent en premier et restent.
   */
  /** Les candidats moins ceux qu'une sélection de `limit` ferait dépasser les plafonds. */
  const cappedPool = (current: QcmItem[], candidates: QcmItem[], limit: number): QcmItem[] => {
    let pool = candidates;
    for (;;) {
      const picked = selectWithinTrivialBudget(current, pool, limit);
      const over = capDrops(picked, caps, (it) => [it.notion]).map((i) => picked[i]).filter((it) => !current.includes(it));
      if (!over.length) return pool;
      pool = pool.filter((it) => !over.includes(it));
    }
  };
  const selectCapped = (current: QcmItem[], candidates: QcmItem[], limit: number): QcmItem[] =>
    selectWithinTrivialBudget(current, cappedPool(current, candidates, limit), limit);
  // POINT DE REPRISE (lib/qcm-checkpoint) : ce que le point de reprise garde, étape par étape ; la plus avancée prime.
  let ckDesigned = ck?.designed;
  let ckVerified = ck?.verified;
  let ckFinal = ck?.final;
  /** Copie figée : la suite modifie les QCM en place (explications réécrites, options remplacées). */
  const frozen = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
  const restoreReserve = (r: QcmReserveState) => {
    nextSpare = r.nextSpare;
    used.clear();
    for (const label of r.used) used.add(label);
    for (const id of r.usedFacts ?? []) usedFacts.add(id);
  };
  const resumedReserve = ckVerified ?? ckDesigned;
  if (resumedReserve) restoreReserve(resumedReserve);
  // Les sujets de l'examen, puis la marge : des notions de réserve qui remplacent sans nouvelle
  // conception une question écartée par la vérification ou la revue finale.
  const lots: Batch[] = ckDesigned?.lots ?? (ckVerified || ckFinal ? [] : toLots([
    ...qcmTopics.map((topic, i) => ({ topic, mold: qcmMolds[i] ?? null })),
    ...takeSpare(spareMargin(count), qcmTopics).map((topic) => ({ topic, mold: null })),
  ]));
  const phaseMs = { ...DEFAULT_PHASE_MS, ...(opts.phaseMs ?? {}) };
  // Une unité par lot conçu, une pour la vérification et la réparation, une pour la revue finale.
  const qcmUnits = lots.length + 2;
  work = new PhaseProgress(8, [
    [{ name: "QCM", units: qcmUnits, ms: phaseMs.QCM }, { name: "Questions ouvertes", units: openCount, ms: phaseMs["Questions ouvertes"] }],
    [{ name: "PDF", units: 1, ms: phaseMs.PDF }],
  ]);
  const progress = work;
  let persistChain: Promise<void> = Promise.resolve();
  /** Enregistre le point de reprise ; les écritures se suivent (la dernière porte l'état le plus récent). Un échec ne coûte que la reprise. */
  const persist = (): Promise<void> => {
    const store = opts.checkpoint;
    if (!store) return persistChain;
    persistChain = persistChain.then(async () => {
      const stage = ckFinal ? { final: ckFinal } : ckVerified ? { verified: ckVerified } : ckDesigned ? { designed: ckDesigned } : {};
      const data: QcmCheckpoint = { v: 2, key: ckKey, plan, open: [...openBySlot.entries()], ...stage };
      try {
        await store.save(data);
      } catch (e) {
        step(`Point de reprise non enregistré (${(e as Error).message.slice(0, 80)}) : la génération continue`, 0);
      }
    });
    return persistChain;
  };
  // partie OUVERTE : chaque question via l'architecte (multi-passes + vérif), au niveau réel.
  // moules « ouverts » échantillonnés depuis l'ADN, imposés à l'architecte.
  // M — lancée AVANT les lots QCM et en parallèle d'eux, plusieurs à la fois (job 9 de CS-290 :
  // 3 ouvertes en série, 16 min sur 27) ; le limiteur global des appels et le backoff du
  // fournisseur bornent la charge. Aucune passe de qualité n'est retirée.
  // Les questions ouvertes déjà construites avant une coupure sont reprises telles quelles.
  const openBySlot = new Map<number, ExamQuestion>(ck?.open ?? []);
  let abandoned = false;
  const tOpen = Date.now();
  const openPhase = (async () => {
    if (openCount <= 0) return;
    const { architectQuestion } = await import("@/lib/architect");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { profile } = require("@/lib/course-profile") as typeof import("@/lib/course-profile");
    const archs: Archetype[] = profile().archetypes;
    const openMolds = sampleMolds(dna, openCount, {
      only: ["proof_analysis", "derivation", "design", "applied_scenario", "formula_computation", "code_trace", "table_fill", "figure_reading"],
    });
    // NOMBRE GARANTI, comme pour les QCM : une ouverte échouée (job 8 de CS-290 : 2 sur 3, sans
    // un mot) est relancée UNE fois, sauf si la cause est une garde ; sinon l'écart est dit.
    // Ce que l'ouverte ne doit pas reprendre (banc rs-mixte du 17/11 : une ouverte reprenait celle
    // d'un examen précédent, et un QCM de l'examen) : les questions déjà posées, puis les sujets
    // des QCM prévus — connus dès le plan, l'ouverte n'attend pas leur rédaction.
    const openAsked = [...recent.map((r) => r.stem), ...qcmTopics.map((t) => t.fact?.statement ?? t.label)];
    let pendingOpen = Array.from({ length: openCount }, (_, i) => i).filter((i) => !openBySlot.has(i));
    if (openBySlot.size) progress.done("Questions ouvertes", openBySlot.size);
    for (let round = 0; pendingOpen.length && round < 2 && !abandoned; round++) {
      const failed: number[] = [];
      await runPool(pendingOpen, openConcurrency(), async (i) => {
        if (abandoned) return;
        const t = openTopic(i); // ouvertes = couverture programme (le focus reste sur les QCM)
        const a = archs[i % archs.length];
        step(`Question ouverte ${i + 1}/${openCount} (architecte${round ? ", nouvel essai" : ""}) : ${t.label}…`, 82 + i);
        try {
          const r = await architectQuestion(a, `${t.label}${t.subTheme ? ` — sous-thème imposé : ${t.subTheme}` : ""}${t.method ? ` — ${t.method}` : ""}`, 15, { maxRounds: 1, mold: openMolds[i] ?? null, asked: openAsked, onStep: (m) => step(`Ouverte ${i + 1} · ${m}`, 82 + i) });
          openBySlot.set(i, { ...r.q, points: 15 });
          await persist();
        } catch (e) {
          lastError = e;
          failed.push(i);
          step(`Question ouverte ${i + 1} ignorée : ${llmFailureReason(e).slice(0, 120)}`, 82 + i);
        } finally {
          progress.done("Questions ouvertes");
        }
      });
      pendingOpen = failed.sort((x, y) => x - y);
      const stop = llmErrorCode(lastError);
      if (!pendingOpen.length || (stop && HARD_STOP_CODES.has(stop))) break;
      if (round === 0) {
        progress.add("Questions ouvertes", pendingOpen.length); // réessai ajouté : le temps restant peut remonter
        step(`${pendingOpen.length} question(s) ouverte(s) manquante(s) → nouvel essai`, 88);
      }
    }
  })();
  const tQcm = Date.now();

  /** Rattache les QCM d'un lot à leur sujet (notion du programme, accent demandé par l'étudiant). */
  const tagged = (bt: Batch, items: QcmItem[]): QcmItem[] => {
    for (const it of items) {
      const slot = bt.topics[it.slot ?? -1];
      if (slot?.method === FOCUS_METHOD) it.focusSlot = true;
      it.notion = slot?.label ?? it.notion ?? null;
      labelFromFact(it);
    }
    return items;
  };
  /**
   * Conçoit en parallèle (QCM_BATCH_CONCURRENCY) les lots pas encore conçus de `done`. RÉSILIENT : un
   * lot illisible est redemandé avec l'erreur (completeJson) ; un lot en échec reste null et ses
   * sujets attendent le comblement. `onLot` suit chaque lot terminé (point de reprise).
   */
  const designLots = async (group: Batch[], done: (QcmItem[] | null)[], onLot: () => Promise<void> = async () => {}) => {
    const todo = group.map((_, k) => k).filter((k) => !done[k]);
    progress.done("QCM", group.length - todo.length);
    await runPool(todo, batchConcurrency(), async (k) => {
      const bt = group[k];
      try {
        done[k] = tagged(bt, await generateQcmBatch(bt.topics, bt.topics.length, step, undefined, bt.guidance, { ...shared, molds: bt.molds }));
      } catch (e) {
        lastError = e;
        done[k] = null;
        step(`Lot QCM échoué (${(e as Error).message.slice(0, 80)})`, 0);
      }
      progress.done("QCM");
      await onLot();
    });
    return done;
  };
  /**
   * Vérifie à l'aveugle les QCM conçus (appels groupés) et garde ceux dont la clé est confirmée,
   * sans rejet. Ceux qui peuvent entrer dans l'examen (`current` : déjà retenus) voient leurs
   * distracteurs triviaux réparés en UN appel, énoncé et clé gardés ; la version réparée n'est pas
   * revérifiée ici, la revue finale l'audite (clé unique comprise). Rend les candidats, la sélection
   * en tête, et les sujets restés sans question : lot en échec (le sujet reste) ou question écartée.
   */
  const vet = async (group: Batch[], done: (QcmItem[] | null)[], current: QcmItem[]) => {
    const designed = done.flatMap((d) => d ?? []);
    await verifyGrouped(designed);
    // Une question faible (réussie avec les seuls noms des notions, réponse trahie par sa longueur,
    // défaut relevé par le correcteur) n'est plus régénérée : elle passe après les questions propres.
    const weak = (it: QcmItem) => !!weaknessOf({ ...it, trivialDistractors: null });
    const verified = designed.filter((it) => it.verified === 1 && !it.rejected);
    qualityDropped += designed.length - verified.length;
    // Un fait neuf demandé, mais la question rattachée à un fait déjà posé aux examens précédents
    // (lib/qcm-facts.attributedFact) : une reprise. Gardée en réserve, son sujet passe à un autre fait.
    const reprised = (bt: Batch, it: QcmItem) => {
      const asked = bt.topics[it.slot ?? -1]?.fact;
      return factMode && !!asked && !!it.factId && it.factId !== asked.id && askedBefore.has(it.factId) && !askedBefore.has(asked.id);
    };
    const held = new Set(group.flatMap((bt, k) => (done[k] ?? []).filter((it) => verified.includes(it) && reprised(bt, it))));
    for (const it of held) { repeatFallback.set(it.stem, it); heldUnreviewed.set(it.stem, it); }
    const ok = verified.filter((it) => !held.has(it)).sort((a, b) => Number(weak(a)) - Number(weak(b)));
    const missing: QcmMissingState[] = [];
    group.forEach((bt, k) => {
      const slots = (done[k] ?? []).map((it, n) => ({ it, s: it.slot ?? n }));
      const got = new Set(slots.filter(({ it }) => ok.includes(it)).map(({ s }) => s));
      // Écartée par la vérification : son sujet cède la place. Jamais conçue (lot en échec, item mal
      // formé ou manquant) : son sujet est redemandé tel quel.
      const designedSlots = new Set(slots.map(({ s }) => s));
      bt.topics.forEach((topic, j) => { if (!got.has(j)) missing.push({ topic, mold: bt.molds[j] ?? null, rejected: designedSlots.has(j) }); });
    });
    const picked = selectCapped(current, ok, count).filter((it) => !current.includes(it));
    const flagged = picked.filter((it) => !!it.trivialDistractors?.length);
    const repaired = (await Promise.all(chunked(flagged).map((c) => replaceTrivialDistractorsBatch(c, step, shared.language).catch((e) => {
      step(`Remplacement des distracteurs ignoré (${(e as Error).message.slice(0, 50)})`, 0);
      return c;
    })))).flat();
    const byStem = new Map(flagged.map((it, k) => [it.stem, repaired[k] ?? it]));
    const candidates = [...picked, ...ok.filter((it) => !picked.includes(it))].map((it) => byStem.get(it.stem) ?? it);
    return { candidates, missing };
  };
  /**
   * Revue finale de candidats en UN appel (finalReview : audit et doublons). `current` : les
   * questions déjà retenues et revues, données comme déjà posées — un candidat qui en reprend une
   * part. Clé refusée ou hors cours, doublon, reprise d'un examen précédent, notion au-delà de son
   * plafond : écarté pour de bon. Rend les candidats qui restent, dans leur ordre. `strictMode` :
   * critère des doublons, relâché quand le comblement reprend des notions sous un autre angle.
   */
  const review = async (cands: QcmItem[], current: QcmItem[], strictMode = strict): Promise<QcmItem[]> => {
    if (!cands.length) return [];
    // Les ouvertes déjà construites comptent comme posées (banc rs-mixte du 17/11 : un QCM et
    // une ouverte sur le même résultat d'impossibilité) : un QCM qui en reprend une part.
    const openStems = [...openBySlot.values()].map((oq) => openAsStem(oq.concept, oq.statement_tex ?? "")).filter(Boolean);
    const { audit, dup } = await finalReview(cands, { strict: strictMode, previous: recent.map((x) => x.stem), current: [...current.map((it) => it.stem), ...openStems], step, facts: shared.facts, programme: programmeLabels });
    const out = cands.map((it, i) => (audit ? audit[i] : it));
    dup?.programme.forEach((p, i) => { if (p && out[i]) out[i]!.programmeNotion = p; });
    cands.forEach((it, i) => { if (!out[i]) auditRejected.add(it.stem); });
    // Même fait testable (lib/qcm-facts) qu'une question déjà retenue ou qu'un candidat avant lui :
    // doublon certain, sans modèle ; le premier reste.
    const sameFact = new Set(factDuplicates([...current, ...cands]).filter((k) => k >= current.length).map((k) => k - current.length));
    if (sameFact.size) step(`Doublons : ${sameFact.size} question(s) sur un fait déjà testé par une autre question`, 80);
    // Doublon DANS l'examen : écarté pour de bon. Reprise d'un examen précédent : écartée, mais
    // gardée en réserve (repeatFallback) si rien ne la remplace.
    const intra = new Set(dup?.intra ?? []);
    for (const i of dup?.repeats ?? []) { historicalRepeats.add(cands[i].stem); if (!intra.has(i) && !sameFact.has(i) && out[i]) repeatFallback.set(cands[i].stem, out[i]!); }
    // Doublon vu par le seul modèle entre deux questions de faits DISTINCTS : remplacé si possible,
    // mais repris si l'examen resterait incomplet (softFallback) — le filet ne fait plus tomber le
    // compte ; le même fait et les plafonds, eux, ne reviennent jamais.
    if (factMode) for (const i of intra) if (cands[i].factId && !sameFact.has(i) && out[i]) softFallback.set(cands[i].stem, out[i]!);
    const dropped = new Set([...(dup?.drop ?? []), ...sameFact]);
    for (const i of [...intra, ...sameFact]) auditDuplicates.add(cands[i].stem);
    // Plafonds par notion sur l'ensemble (questions déjà retenues d'abord) : notion planifiée (sujet
    // du lot), jamais le libellé libre de la revue (PR #94 : notion-parapluie), puis notion de la
    // bonne réponse.
    const rest = cands.map((_, i) => i).filter((i) => out[i] && !dropped.has(i));
    const capped = capDrops([...current, ...rest.map((i) => out[i]!)], caps, (it) => [it.notion])
      .filter((k) => k >= current.length).map((k) => rest[k - current.length]);
    for (const i of capped) { auditDuplicates.add(cands[i].stem); softFallback.delete(cands[i].stem); }
    if (!dup) step(`Doublons : revue finale indisponible, plafonds par notion appliqués seuls (${capped.length} retrait(s))`, 80);
    const refused = out.filter((x) => !x).length;
    const duplicates = [...dropped].filter((i) => out[i]).length + capped.length;
    if (refused || duplicates) step(`Revue finale : ${refused} QCM écarté(s) (clé ou hors cours), ${duplicates} doublon(s) ou au-delà du plafond par notion`, 80);
    const keptIdx = rest.filter((i) => !capped.includes(i));
    for (const i of keptIdx) if (dup?.notions[i]) reviewed.set(out[i]!.stem, { notion: dup.notions[i], angle: dup.angles[i] ?? "" });
    const kept = keptIdx.map((i) => out[i]!);
    // Le pool garde la version revue de chaque candidat.
    const byStem = new Map(kept.map((it) => [it.stem, it]));
    verifiedCandidates.splice(0, verifiedCandidates.length, ...verifiedCandidates.map((c) => byStem.get(c.stem) ?? c));
    return kept;
  };
  /** Consigne d'un lot de comblement par faits : les faits que l'examen teste déjà. */
  const factGuidance = (): string | undefined => {
    const facts = all.flatMap((it) => (it.factId ? plan.facts?.filter((f) => f.id === it.factId) ?? [] : []));
    return facts.length
      ? `FAITS DÉJÀ TESTÉS par d'autres questions de cet examen — n'en teste AUCUN, même sous un autre scénario ou un autre décor :\n${facts.map((f) => `  · [${f.id}] ${sanitizeCorpus(f.statement).slice(0, 160)}`).join("\n")}`
      : undefined;
  };
  /**
   * COMBLEMENT, une ronde au plus — il manque des questions après la revue (lot en échec, rejets
   * au-delà de la marge, doublons). Un sujet de lot en échec est redemandé tel quel ; une question
   * écartée cède sa place à une notion de réserve (HUM-285, job 12 du 13/11 : un sujet hors cours
   * redemandé tel quel rendait le même rejet) ; à défaut, les notions les moins posées, sous un
   * angle VRAIMENT distinct. En dessous malgré tout, l'examen le dit (requested) et le job
   * rembourse au prorata.
   */
  const topUp = async (missing: QcmMissingState[]) => {
    const short = count - all.length;
    if (short <= 0 || hardStop() || (!all.length && lastError)) return;
    const want = short + spareMargin(short);
    const retry: Slot[] = missing.filter((m) => !m.rejected || m.topic.method === FOCUS_METHOD).slice(0, want).map((m) => ({ topic: m.topic, mold: m.mold }));
    const spare = takeSpare(want - retry.length);
    const angle = retry.length + spare.length < short;
    const slots: Slot[] = [...retry, ...spare.map((topic) => ({ topic, mold: null }))];
    if (angle) slots.push(...repeatSlots(want - slots.length, slots.map((s) => s.topic)).map((topic) => ({ topic, mold: null })));
    // Toutes les notions à leur plafond et plus de réserve : le manque reste dit et remboursé.
    if (!slots.length) return;
    // Le lot sait ce que l'examen pose déjà, sous les noms donnés par la revue (le libellé du
    // programme à défaut) : en mode strict, aucune de ces notions ; sinon un angle vraiment distinct.
    const known = all.map((it) => reviewed.get(it.stem) ?? { notion: it.notion ?? it.topic ?? "", angle: "" }).filter((k) => k.notion);
    const guidance = factMode && !angle ? factGuidance() : !known.length ? undefined : strict && !angle
      ? `NOTIONS DÉJÀ TESTÉES par d'autres questions de cet examen — n'en reprends AUCUNE, même sous un autre angle : ${[...new Set(known.map((k) => sanitizeCorpus(k.notion).slice(0, 80)))].join(" · ")}.`
      : `NOTIONS DÉJÀ TESTÉES par d'autres questions de cet examen, avec leur angle — si tu reprends l'une d'elles, teste un angle vraiment distinct (un autre fait, une autre condition, une autre étude), jamais la même question reformulée : ${known.map((k) => `${sanitizeCorpus(k.notion).slice(0, 60)} (${sanitizeCorpus(k.angle || "?").slice(0, 60)})`).join(" · ")}.`;
    const extra = toLots(slots, guidance);
    progress.add("QCM", extra.length + 2); // ronde ajoutée : le temps restant peut remonter
    step(`${short} QCM manquant(s) → ${extra.length} lot(s) de comblement${angle ? " (notions reprises sous un autre angle)" : ""}`, 80);
    const done = await designLots(extra, []);
    const { candidates } = await vet(extra, done, all);
    verifiedCandidates.push(...candidates);
    progress.done("QCM");
    // Notions reprises sous un autre angle : le critère strict (une notion = une question) ne tient plus.
    const passed = await review(candidates, all, strict && !angle);
    progress.done("QCM");
    all.splice(0, all.length, ...selectCapped(all, passed, count));
  };
  /**
   * DISTRACTEURS ENCORE ÉLIMINABLES — la revue relève un remplaçant sur deux encore éliminable
   * (banc HUM-285 du 15/11), et deux options qui nomment la même notion trahissent la réponse (job
   * 23, Q9). Au-delà du budget de 10 % de distracteurs triviaux, ou dès qu'une option se répète :
   * UNE seconde réparation, revérifiée à l'aveugle en UN appel ; elle ne remplace que si elle est
   * confirmée et meilleure. Le budget dépassé ne relance plus de lots de conception : une question
   * imparfaite, vérifiée, vaut mieux qu'une place remboursée.
   */
  const repairResidue = async () => {
    const over = overTrivialBudget(all);
    const flagged = all.filter((it) => duplicateOptionIndices(it.options, it.correct).length || (over && !!it.trivialDistractors?.length));
    if (!flagged.length) return;
    const sent = flagged.map((it) => {
      const d = duplicateOptionIndices(it.options, it.correct);
      return { ...it, duplicateOptions: d, trivialDistractors: [...new Set([...(it.trivialDistractors ?? []), ...d])] };
    });
    const repaired = (await Promise.all(chunked(sent).map((c) => replaceTrivialDistractorsBatch(c, step, shared.language).catch(() => c)))).flat();
    const changed = repaired.filter((r, k) => r !== sent[k]);
    if (changed.length) await verifyGrouped(changed);
    let fixed = 0;
    flagged.forEach((it, k) => {
      const r = repaired[k];
      if (!r || r === sent[k] || r.verified !== 1 || !!r.rejected || duplicateOptionIndices(r.options, r.correct).length) return;
      if (!duplicateOptionIndices(it.options, it.correct).length && (r.trivialDistractors?.length ?? 0) >= (it.trivialDistractors?.length ?? 0)) return;
      all[all.indexOf(it)] = r;
      fixed++;
    });
    step(`Contrôle final : ${flagged.length} QCM à distracteurs encore éliminables ou options répétées → ${fixed} corrigé(s), revérifiés à l'aveugle`, 81);
  };
  /** Le fait de `it` est-il déjà testé par une question de l'examen ? */
  const factTaken = (it: QcmItem) => !!it.factId && all.some((x) => x !== it && x.factId === it.factId);
  /**
   * Remet dans un examen incomplet des questions déjà vérifiées et revues, écartées faute de mieux
   * (`from`), tant qu'il manque des places : jamais une question présente, refusée par la revue,
   * exclue par `skip`, au-delà d'un plafond par notion ou sur un fait déjà testé. Rend le nombre remis.
   */
  const restoreFallback = (from: Map<string, QcmItem>, skip: (it: QcmItem) => boolean = () => false): number => {
    let back = 0;
    for (const it of from.values()) {
      if (all.length >= count) break;
      if (all.some((x) => x.stem === it.stem) || auditRejected.has(it.stem) || skip(it)) continue;
      if (capDrops([...all, it], caps, (x) => [x.notion]).includes(all.length) || factTaken(it)) continue;
      all.push(it);
      back++;
    }
    return back;
  };
  /**
   * Candidats vérifiés, déjà payés, absents de l'examen et jamais reconnus comme doublons — ni
   * d'un fait déjà testé par une question de l'examen (même fait, ou même notion sous le même
   * scénario : examen #16, Q3/Q12), pour qu'un retrait de la phase finale ne ramène pas son jumeau.
   */
  const spareCandidates = () => {
    const present = new Set(all.map((it) => it.stem));
    return verifiedCandidates.filter((c) => c.verified === 1 && !c.rejected && !present.has(c.stem) && !auditDuplicates.has(c.stem) && !auditRejected.has(c.stem) && !historicalRepeats.has(c.stem) && !duplicateOptionIndices(c.options, c.correct).length && optionCountFits(c.options.length, expectedOptionCount(c.type, shared.optionsPerQuestion)) &&
      !factDuplicates([...all, c]).includes(all.length));
  };
  /** Remplace `it` par un candidat déjà payé qui tient les plafonds ; sinon le retire si `drop`. Rend vrai si remplacé. */
  const swapOut = (it: QcmItem, drop: boolean): boolean => {
    const i = all.indexOf(it);
    if (i < 0) return false;
    const others = all.filter((x) => x !== it);
    const picked = selectCapped(others, spareCandidates(), others.length + 1);
    if (picked.length > others.length) { all[i] = picked[picked.length - 1]; return true; }
    if (drop) all.splice(i, 1);
    return false;
  };
  /**
   * Budget TEMPS de la phase finale (finalPhaseBudgetMs), armé juste après la revue finale : à
   * épuisement, plus de ronde de comblement ni de réparation, et la porte de sortie n'appelle plus
   * le modèle (revérification, explications) — la meilleure version déjà vérifiée est gardée, le
   * manque éventuel est remboursé au prorata (lib/jobs.ts, refundGeneration). Seuls les contrôles
   * déterministes de la porte de sortie restent inconditionnels.
   */
  let finalPhaseDeadline = Number.POSITIVE_INFINITY;
  let finalPhaseBudgetLogged = false;
  const finalPhaseExhausted = (): boolean => {
    const over = Date.now() >= finalPhaseDeadline;
    if (over && !finalPhaseBudgetLogged) {
      finalPhaseBudgetLogged = true;
      step(`Dernière vérification : budget de la phase finale atteint, les QCM déjà vérifiés sont gardés tels quels`, 85);
    }
    return over;
  };
  const exitGate = async () => {
    // 0. Nombre d'options, sans appel au modèle : celui de l'annale, ou quatre pour une SCQ quand
    // il est inconnu, quel que soit son chemin (reprise d'un point de reprise compris).
    const misshapen = all.filter((it) => !optionCountFits(it.options.length, expectedOptionCount(it.type, shared.optionsPerQuestion)));
    if (misshapen.length) {
      misshapen.forEach((it) => { auditRejected.add(it.stem); swapOut(it, true); });
      step(`Contrôle final : ${misshapen.length} QCM sans le nombre d'options attendu → remplacé(s) ou retiré(s)`, 81);
    }
    // 1. Plafonds par notion sur l'ensemble final ; un retrait est remplacé par un candidat payé.
    const over = [...new Set([...capDrops(all, caps, (it) => [it.notion]), ...factDuplicates(all)])].map((i) => all[i]);
    if (over.length) {
      over.forEach((it) => auditDuplicates.add(it.stem));
      all.splice(0, all.length, ...all.filter((it) => !over.includes(it)));
      all.splice(0, all.length, ...selectCapped(all, spareCandidates(), count));
      step(`Contrôle final : ${over.length} QCM au-delà du plafond par notion retiré(s)`, 81);
    }
    // 2. Deux options qui nomment encore la même notion après la seconde réparation : un autre
    // candidat payé prend sa place, sinon la question reste (signalée au journal).
    const repeated = all.filter((it) => duplicateOptionIndices(it.options, it.correct).length);
    if (repeated.length) {
      const kept = repeated.filter((it) => !swapOut(it, false)).length;
      step(`Contrôle final : ${repeated.length} QCM à options répétées → ${repeated.length - kept} remplacé(s)${kept ? `, ${kept} gardé(s) faute de remplaçant vérifié` : ""}`, 81);
    }
    // 3. Jamais de « not_verified » quand la vérification est possible : une question restée sans
    // verdict est vérifiée à l'aveugle ; rejetée, elle cède sa place à un candidat ou part ; correcteur
    // indisponible, elle reste, signalée non vérifiée.
    const unverified = all.filter((it) => it.verified !== 1 || !!it.rejected);
    if (unverified.length) {
      // Budget épuisé : jamais d'appel de plus, mais l'invariant reste — une question restée sans
      // verdict est remplacée par un candidat déjà vérifié, ou retirée ; jamais gardée non vérifiée.
      if (!finalPhaseExhausted()) await verifyGrouped(unverified.filter((it) => !it.rejected));
      let kept = 0;
      for (const it of unverified) {
        if (it.verified === 1 && !it.rejected) { kept++; continue; }
        swapOut(it, it.verified === 0 || !!it.rejected);
      }
      step(`Contrôle final : ${unverified.length} QCM sans verdict → ${kept} vérifié(s) à l'aveugle${kept < unverified.length ? `, ${unverified.length - kept} remplacé(s), retiré(s) ou laissé(s) non vérifié(s) (correcteur indisponible)` : ""}`, 81);
    }
    // 4. Explications : réfutent-elles exactement les options proposées ? Contrôle sans modèle, puis
    // réécriture sur les options réelles ; à défaut, l'explication est réduite à la justification de la clé.
    // Optimisation de qualité, pas une garantie : elle cède la place au budget de la phase finale.
    // Justification structurée (lib/qcm-rationale) : contrôle de la STRUCTURE, sans heuristique de
    // texte — une raison par distracteur réel, aucune orpheline ; les seules cases vides (option
    // remplacée sans raison rendue, raison effacée par le filet) sont écrites en UN appel groupé.
    // L'explication est ensuite réassemblée depuis les options réelles : rien d'autre n'y entre.
    const gaps = finalPhaseExhausted() ? [] : all.filter((it) => !!it.rationale && !rationaleCheck(it.rationale, it.options.length, it.correct).ok);
    const filling = gaps.length
      ? coursePassages([...new Set(gaps.map((it) => it.topic).filter(Boolean))]).catch(() => []).then((passages) => writeJustifications(gaps.map((it): JustificationTarget => {
        const c = rationaleCheck(it.rationale, it.options.length, it.correct);
        return { ...it, key: it.rationale!.key, wrong: it.rationale!.wrong, want: { key: !c.key, options: c.missing } };
      }), languageName(shared.language ?? examLanguageFor(currentCourse()))[1], passages))
      : Promise.resolve([]);
    const flagged = finalPhaseExhausted() ? [] : all.filter((it) => !it.rationale).map((it) => ({ it, issue: explanationIssues(it.explanation ?? "", it.options, it.correct, it.stem) })).filter((x) => !!x.issue);
    const filled = await filling;
    if (gaps.length) {
      let complete = 0;
      gaps.forEach((it, k) => {
        const c = rationaleCheck(it.rationale, it.options.length, it.correct);
        it.rationale = cleanRationale(fillRationale(it.rationale!, filled[k], { key: !c.key, options: c.missing }, it.options.length, it.correct), it.options, it.correct, it.stem);
        syncExplanation(it);
        if (rationaleCheck(it.rationale, it.options.length, it.correct).ok) complete++;
      });
      step(`Contrôle final : ${gaps.length} justification(s) incomplète(s) → ${complete} complétée(s) case par case${complete < gaps.length ? `, ${gaps.length - complete} limitée(s) aux raisons écrites` : ""}`, 81);
    }
    if (flagged.length) {
      const passages = await coursePassages([...new Set(flagged.map((x) => x.it.topic).filter(Boolean))]).catch(() => []);
      const rewritten = await rewriteExplanationsOnOptions(
        flagged.map(({ it, issue }) => ({ stem: it.stem, options: it.options, correct: it.correct, explanation: it.explanation, issue: describeExplanationIssue(issue!) })),
        languageName(shared.language ?? examLanguageFor(currentCourse()))[1],
        passages,
      );
      let fixed = 0;
      let trimmed = 0;
      flagged.forEach(({ it }, k) => {
        const text = rewritten[k];
        if (text && !citesOptionLabel(text, it.options.length) && !citesAbsentDistractor(text, it.options) && !explanationIssues(text, it.options, it.correct, it.stem)) {
          it.explanation = text;
          fixed++;
          return;
        }
        const short = keyOnlyExplanation(it.explanation ?? "");
        if (short) { it.explanation = short; trimmed++; }
      });
      step(`Contrôle final : ${flagged.length} explication(s) réfutant des options absentes ou trop nombreuses → ${fixed} réécrite(s) sur les options réelles${trimmed ? `, ${trimmed} réduite(s) à la justification de la clé` : ""}`, 81);
    }
    // 5. L'étiquette de notion a-t-elle un appui lexical dans ce que la question teste (fait source,
    // bonne réponse, explication) ? Sans appel au modèle : recalée sur le libellé du programme le
    // plus proche (job 25, Q5 : étiquetée hors sujet, les points faibles de l'étudiant en souffrent).
    // S'applique à CHAQUE question de l'ensemble final, y compris celles arrivées par un
    // remplacement de doublon ou le complément : cette passe tourne sur `all` dans son état le plus
    // récent, après chaque appel à `exitGate` (finition v5 : vérifié, rien à changer ici — la
    // relecture avait d'abord tenté de comparer un SCORE plutôt que `notionMismatch`, pour couvrir
    // une étiquette qui partage un seul mot générique avec le contenu testé ; ça relabelisait aussi
    // des questions correctement étiquetées dès qu'une autre notion du programme avait, par hasard,
    // un mot de plus en commun — régression sur le job 23/examen 9, revenue en arrière).
    // L'accent demandé par l'étudiant garde son étiquette, choisie par lui, pas par le programme.
    let relabeled = 0;
    for (const it of all) {
      // Question bâtie sur un fait du cours : la notion de ce fait fait foi, sans heuristique…
      labelFromFact(it);
      const fromFact = factNotion(it.factId);
      // … sauf examen #16, Q8 : la définition d'une notion, étiquetée sous celle où son fait avait été
      // rangé à l'extraction. La revue finale nomme une autre notion du programme, et ni la bonne
      // réponse ni l'énoncé du fait ne contiennent un mot de l'étiquette : la notion nommée l'emporte.
      if (fromFact && !it.focusSlot && it.programmeNotion && notionBase(it.programmeNotion) !== notionBase(fromFact)) {
        const statement = shared.facts?.find((f) => f.id === it.factId)?.statement ?? "";
        if (notionMismatch(fromFact, `${it.options[it.correct[0] ?? -1] ?? ""} ${statement}`, 1)) { it.notion = it.programmeNotion; it.topic = it.programmeNotion; relabeled++; }
        continue;
      }
      if (it.focusSlot || !it.notion || fromFact) continue;
      const tested = [it.sourceFact, it.explanation, it.options[it.correct[0] ?? -1]].filter(Boolean).join(" ");
      if (!tested.trim() || !notionMismatch(it.notion, tested)) continue;
      const best = bestNotionMatch(tested, programmeLabels);
      // L'étiquette AFFICHÉE suit (topic) : seule la notion interne changeait (job 25, Q5, resté affiché).
      if (best && notionBase(best) !== notionBase(it.notion)) { it.notion = best; it.topic = best; relabeled++; }
    }
    if (relabeled) step(`Contrôle final : ${relabeled} étiquette(s) de notion recalée(s) sur le passage source de la clé`, 81);
  };
  // REPRISE : ce qui est acquis revient sans aucun appel ; la conception ne refait que les lots
  // manquants. Une figure perdue avec le conteneur écarte son QCM (son sujet est comblé).
  const resumedDesign = (ckDesigned?.items ?? []).map((d) => (d ? withFigurePresent(d, examsDir()) : null));
  let missing: QcmMissingState[] = [];
  if (ckFinal) {
    // Enregistré : ses figures portent déjà leur nom définitif.
    all.push(...(ckFinal.examId != null ? ckFinal.items : withFigurePresent(ckFinal.items, examsDir())));
    progress.done("QCM", qcmUnits);
  } else if (ckVerified) {
    verifiedCandidates.push(...withFigurePresent(ckVerified.candidates, examsDir()));
    missing = ckVerified.missing;
    qualityDropped = ckVerified.qualityDropped;
    progress.done("QCM", qcmUnits - 1);
  }
  if (ck) {
    const acquired = ckFinal ? `${all.length} QCM prêts` : ckVerified ? `${verifiedCandidates.length} QCM déjà conçus et vérifiés` : `${resumedDesign.flat().filter(Boolean).length} QCM déjà conçus`;
    step(`Reprise après interruption : ${acquired}${openBySlot.size ? `, ${openBySlot.size} question(s) ouverte(s)` : ""} repris sans nouvel appel`, 8);
  }
  if (!ckFinal) {
    if (!ckVerified) {
      const done = lots.map((_, k) => resumedDesign[k] ?? null);
      const saveDesigned = () => {
        ckDesigned = frozen({ lots, items: done, nextSpare, used: [...used], usedFacts: [...usedFacts] });
        return persist();
      };
      await designLots(lots, done, saveDesigned);
      const vetted = await vet(lots, done, []);
      verifiedCandidates.push(...vetted.candidates);
      missing = vetted.missing;
      ckVerified = frozen({ candidates: verifiedCandidates, missing, qualityDropped, nextSpare, used: [...used], usedFacts: [...usedFacts] });
      await persist();
      progress.done("QCM");
    }
    step(`${verifiedCandidates.length} QCM construits + vérifiés pour ${count} places → revue finale…`, 78);
    const passed = await review(verifiedCandidates, []);
    progress.done("QCM");
    // Le budget de la phase finale démarre ici, APRÈS la revue finale : la revue est un seul appel,
    // toujours fait (≈ 5 min au banc HUM-285 du 16/11) ; armé avant elle, le budget de 6 min de
    // #108 ne laissait plus rien à la porte de sortie, dont la réécriture des explications sautait
    // (6 explications incohérentes livrées contre 0,3 avant le rebase). Il borne ce qui peut boucler :
    // comblement, seconde réparation, appels au modèle de la porte de sortie.
    // Étape honnête : au-delà, l'avancement reste à 99 % (lib/progress) ; l'étudiant lit ce qui se
    // passe et combien de temps cela peut encore prendre, au lieu de « moins d'une minute » pendant 40 min.
    finalPhaseDeadline = Date.now() + finalPhaseBudgetMs();
    step(`Dernière vérification de l'examen (doublons, clés, distracteurs) : au plus ${Math.ceil(finalPhaseBudgetMs() / 60_000)} min de plus`, 78);
    all.splice(0, all.length, ...selectCapped([], passed, count));
    if (!finalPhaseExhausted()) await topUp(missing);
    // Toujours en dessous du nombre demandé : les reprises d'un examen précédent, déjà vérifiées et
    // auditées, reprennent les places vides (plafonds par notion tenus) plutôt qu'un remboursement.
    // Une reprise mise de côté dès la vérification n'a pas vu la revue finale : revue maintenant, si
    // elle doit servir et que le budget le permet ; sinon elle ne revient pas.
    if (all.length < count && heldUnreviewed.size && !finalPhaseExhausted()) {
      for (const it of await review([...heldUnreviewed.values()], all)) repeatFallback.set(it.stem, it);
      heldUnreviewed.clear();
    }
    const repeatsBack = restoreFallback(repeatFallback, (it) => auditDuplicates.has(it.stem) || heldUnreviewed.has(it.stem));
    if (repeatsBack) step(`${repeatsBack} question(s) proche(s) d'un examen précédent gardée(s) faute de remplaçant : chaque notion du cours a déjà été posée`, 80);
    // Toujours en dessous : les questions que le seul contrôle du modèle avait retirées alors
    // qu'elles testent un fait distinct reprennent les places vides (plafonds tenus, jamais un fait
    // déjà testé). Le dédoublonnage par fait est structurel ; ce contrôle reste un filet qui
    // remplace, mais ne fait plus tomber le compte.
    const softBack = restoreFallback(softFallback);
    if (softBack) step(`${softBack} question(s) d'un fait distinct gardée(s) faute de remplaçant, malgré un rapprochement signalé par le contrôle des doublons`, 80);
    // Une seule réparation, bornée ; optimisation de qualité et non une garantie, elle cède la
    // place au budget de la phase finale (#105), les QCM gardent leur version vérifiée.
    if (!finalPhaseExhausted()) await repairResidue();
    // PORTE DE SORTIE — job 23 (14/11/2026, examen QCM #9) : livré avec trois questions sur le biais
    // de disponibilité, neuf explications qui réfutaient des options absentes, deux options « biais
    // de disponibilité » dans une même question et une question « not_verified ». Rien n'est
    // enregistré sans passer ici, sur l'ensemble final, reprise comprise — seul un ensemble qui l'a
    // déjà franchie (point de reprise `final`) ne la repasse pas.
    if (all.length) await exitGate();
  }
  // Aucun appel en erreur mais tous les items écartés (mal formés) : c'est une réponse inutilisable.
  const cause = () => lastError ?? new LlmError("Toutes les questions reçues étaient mal formées.", "BAD_OUTPUT");
  if (count > 0 && !all.length) {
    abandoned = true; // les ouvertes en cours s'arrêtent après leur question
    await openPhase;
    // Banc du 04/11 : « réponse illisible » se disait aussi quand le modèle avait répondu et que
    // toutes ses questions avaient été écartées par les contrôles — la cause doit être exacte.
    if (!lastError && (qualityDropped > 0 || verifiedCandidates.length > 0)) {
      const dropped = Math.max(qualityDropped, verifiedCandidates.length);
      throw new Error(`Aucun QCM généré : les ${dropped} questions conçues ont toutes été écartées par les contrôles de qualité (hors cours, clé contestée, distracteurs trop faciles). Réessaie ; si ça se reproduit sur ce cours, signale-le.`);
    }
    throw new Error(`Aucun QCM généré : ${llmFailureReason(cause())}`);
  }
  logPhase("QCM", tQcm);
  // L'ensemble a franchi la porte de sortie : une coupure à partir d'ici ne le refait plus.
  if (!ckFinal) {
    ckFinal = { items: frozen(all) };
    await persist();
  }

  // M — LIVRAISON PROGRESSIVE : l'examen et ses QCM vérifiés sont enregistrés tout de suite
  // (statut « generating ») et visibles dans /mock/N ; les ouvertes arrivent ensuite.
  // Déjà enregistré avant une coupure (point de reprise `final`) : le même examen est complété.
  const reused = ckFinal.examId != null && !!(await q.get(`SELECT id FROM exams WHERE id = ?`, ckFinal.examId));
  const examId = reused ? ckFinal.examId! : await q.insert(`INSERT INTO exams (format_template, status) VALUES ('qcm','generating')`);
  if (!reused) {
    // CONTRÔLE DÉTERMINISTE FINAL des justifications structurées : une raison par distracteur réel,
    // chaque raison sur une option qui existe, aucune orpheline ; l'explication enregistrée est
    // réassemblée ici, sur les options telles qu'elles partent en base.
    const structured = all.filter((it) => !!it.rationale);
    if (structured.length) {
      const complete = structured.filter((it) => rationaleCheck(syncExplanation(it).rationale, it.options.length, it.correct).ok).length;
      step(`Explications assemblées depuis leur justification : ${complete}/${structured.length} complètes (une raison par distracteur)${structured.length < all.length ? `, ${all.length - structured.length} en texte libre` : ""}`, 81);
    }
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
        const rationaleJson = it.rationale ? JSON.stringify(toStoredRationale(it.rationale, it.options.length, it.correct)) : null;
        await q.run(`INSERT INTO qcm_items (exam_id, idx, topic, type, stem, options_json, correct_json, misconceptions_json, explanation, verified, mold, figure_json, fact_id, rationale_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, examId, i, it.topic, it.type, it.stem, JSON.stringify(it.options), JSON.stringify(it.correct), JSON.stringify(it.misconceptions), it.explanation, it.verified, it.mold ?? null, figureJson, it.factId ?? null, rationaleJson);
      }
    });
    ckFinal = { items: frozen(all), examId };
    await persist();
  }
  const verified = all.filter((it) => it.verified === 1).length;
  if (openCount > 0 && all.length) {
    await q.run(`UPDATE exams SET verify_summary = ? WHERE id = ?`, `${qcmExamSummary({ count: all.length, requested: count, verified, open: 0, openRequested: 0 })}, questions ouvertes en cours`, examId);
    step(`${all.length} QCM visibles dans l'examen #${examId} : questions ouvertes en cours…`, 82);
    await opts.onExamReady?.(examId, { requested: count + openCount });
  }
  await openPhase;
  if (openCount > 0) logPhase("Questions ouvertes", tOpen);

  const openQs = [...openBySlot.entries()].sort((a, b) => a[0] - b[0]).map(([, oq]) => oq);
  // Contrôle final du total demandé : ce qui manque encore est dit ici, et remboursé par le job.
  if (all.length + openQs.length < count + openCount) {
    step(`⚠ ${all.length + openQs.length} questions sur ${count + openCount} demandées (${all.length}/${count} QCM, ${openQs.length}/${openCount} ouvertes)`, 90);
  }

  if (!all.length && !openQs.length) {
    // L'examen a été enregistré tôt (livraison progressive) : vide, il ne reste pas en liste.
    await q.run(`DELETE FROM exams WHERE id = ?`, examId);
    throw new Error(`Rien n'a pu être généré (lots QCM et questions ouvertes échoués) : ${llmFailureReason(cause())}`);
  }

  // Les ouvertes rejoignent l'examen déjà enregistré ; il passe « prêt ».
  await q.tx(async () => {
    // Examen repris : des ouvertes y ont peut-être déjà été jointes avant la coupure.
    if (reused) await q.run(`DELETE FROM exam_questions WHERE exam_id = ?`, examId);
    for (const oq of openQs) {
      await q.run(`INSERT INTO exam_questions (exam_id, concept, statement_html, solution_html, source_inspiration) VALUES (?,?,?,?,?)`, examId, oq.concept, oq.statement_tex, oq.solution_tex, "qcm-open");
    }
  });
  await q.run(`UPDATE exams SET verify_summary = ?, status = 'ready' WHERE id = ?`, qcmExamSummary({ count: all.length, requested: count, verified, open: openQs.length, openRequested: openCount }), examId);

  // rendu PDF (énoncé + corrigé) au look d'un vrai final du cours
  step("Rendu du PDF (look vrai final)…", 92);
  const tPdf = Date.now();
  let pdf: string | undefined, texError: string | undefined;
  try {
    const { buildQcmArtifact } = await import("@/lib/qcm-latex");
    const dateLabel = nowStr().slice(0, 10);
    const out = await buildQcmArtifact(examId, { items: all, open: openQs }, dateLabel);
    pdf = out.file || undefined; texError = out.texError;
    if (out.texWarning) step(`⚠ ${out.texWarning}`, 96);
    if (out.file) await q.run(`UPDATE exams SET html_path = ? WHERE id = ?`, out.file, examId);
  } catch (e) { texError = (e as Error).message; }
  // Jamais silencieux (examen 4 de CS-290 : « prêt » 16 ms après « Rendu du PDF », sans PDF ni
  // trace) : l'étape le dit, l'examen reste consultable en ligne et le PDF se régénère à part.
  if (texError) step(`⚠ PDF non compilé (${texError.slice(0, 160)}), l'examen reste consultable en ligne`, 97);
  progress.done("PDF");

  logPhase("PDF", tPdf);
  logPhase("Total", tStart);
  report(`Examen QCM #${examId} prêt : ${qcmExamSummary({ count: all.length, requested: count, verified, open: openQs.length, openRequested: openCount })} ✓`, 100);
  return { id: examId, count: all.length, requested: count, verified, open: openQs.length, openRequested: openCount, pdf, texError };
}

/** Résumé de l'examen : « QCM : 5 sur 7 demandés, dont 4 vérifiés · 3 questions ouvertes » ; rien de signalé s'il est complet. */
export function qcmExamSummary(r: Pick<QcmExamResult, "count" | "requested" | "verified" | "open" | "openRequested">): string {
  return qcmSummaryText(r);
}

/**
 * Note que la vérification ajoutait à l'explication (avant le 02/11/2026) quand le correcteur
 * contestait la clé — qu'elle la remplace (l'explication défendait alors l'ANCIENNE réponse) ou
 * qu'il relève seulement un défaut. Les deux cas ne se distinguent plus : la note n'est jamais
 * montrée, ni l'explication qu'elle accompagne.
 */
const LEGACY_KEY_NOTE = /\[clé (?:corrigée à la vérif\b|alignée sur la résolution indépendante)/;

/** L'explication telle que l'étudiant la lit. */
export function shownExplanation(raw: string | null | undefined): string {
  const text = raw ?? "";
  if (LEGACY_KEY_NOTE.test(text)) {
    return "Explication retirée : la vérification avait relevé un problème sur cette question, et l'explication d'origine peut ne pas justifier la réponse retenue.";
  }
  // Une explication par RANG (« la première option ») ne peut venir que d'avant ce contrôle : elle
  // n'était pas repérée et ses options ont été mélangées, elle désigne donc une autre option que
  // celle qu'elle nomme (la vérification la rejette désormais). Par lettre, les options restaient
  // dans l'ordre.
  if (citesOptionRank(text) && !citesOptionLetter(text)) {
    return "Explication retirée : elle désignait les options par leur position, que le mélange des options a changée.";
  }
  return text;
}

export type QcmOpenView = { id: number; concept: string; statement: string; solution: string };
export type QcmExamView = { id: number; createdAt: string; status: string; verifySummary: string | null; pdf: string | null; solutions: string | null; items: (Omit<QcmItem, "correct" | "misconceptions"> & { id: number; idx: number })[]; open: QcmOpenView[] };
type QcmExamRow = { id: number; created_at: string; verify_summary: string | null; html_path: string | null };
type QcmItemRow = {
  id: number; idx: number; topic: string; type: "scq" | "mcq"; stem: string;
  options_json: string; correct_json: string; misconceptions_json: string; explanation: string;
  verified: 0 | 1 | null; mold: MoldKind | null; figure_json: string | null; rationale_json?: string | null;
};

/** L'explication lue d'un QCM enregistré : assemblée depuis sa justification structurée s'il en a une, sinon le texte d'avant. */
function rowExplanation(r: { rationale_json?: string | null; options_json: string; correct_json: string; explanation: string | null }): string {
  return r.rationale_json ? storedExplanation(r, shownExplanation(r.explanation)) : shownExplanation(r.explanation);
}
type QcmOpenRow = { id: number; concept: string; statement_html: string | null; solution_html: string | null };

/** Un examen QCM pour l'affichage (SANS les clés — l'auto-correction se fait via /api). */
export async function getQcmExam(examId: number, withKeys = false): Promise<QcmExamView | null> {
  await ensureQcmSchema();
  const e = await q.get<QcmExamRow & { status: string | null }>(`SELECT id, created_at, status, verify_summary, html_path FROM exams WHERE id = ? AND format_template = 'qcm'`, examId);
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
    id: e.id, createdAt: e.created_at, status: e.status ?? "ready", verifySummary: examSummaryLabel(e.verify_summary), pdf: e.html_path ?? null,
    // Corrigé : seulement s'il a compilé (J — examen 2 de CS-290 : « Énoncé » sans « Corrigé »).
    solutions: e.html_path?.endsWith(".pdf") && (await storage().stat(path.join(examsDir(), path.basename(e.html_path).replace(/\.pdf$/, "-corrige.pdf")))) ? e.html_path.replace(/\.pdf$/, "-corrige.pdf") : null,
    items: rows.map((r) => {
      let figure: string | null = null;
      try { figure = r.figure_json ? (JSON.parse(r.figure_json).file ?? null) : null; } catch {}
      return {
        id: r.id, idx: r.idx, topic: r.topic, type: r.type, stem: r.stem,
        options: JSON.parse(r.options_json), explanation: withKeys ? rowExplanation(r) : "", verified: r.verified,
        mold: r.mold ?? null, figureFile: figure,
        ...(withKeys ? { correct: JSON.parse(r.correct_json), misconceptions: JSON.parse(r.misconceptions_json) } : {}),
      };
    }) as QcmExamView["items"],
    open,
  };
}

/**
 * Recompile le PDF d'un examen QCM depuis la base, SANS le modèle (gratuit) : examens
 * restés sans PDF (garde trop strict, LaTeX d'une ouverte cassé) — bouton « régénérer le
 * PDF » et rattrapage des examens existants. null si l'examen n'est pas un examen QCM.
 */
export async function recompileQcmPdf(examId: number): Promise<{ file: string; texError?: string; texWarning?: string } | null> {
  await ensureQcmSchema();
  const e = await q.get<{ id: number; created_at: string }>(`SELECT id, created_at FROM exams WHERE id = ? AND format_template = 'qcm'`, examId);
  if (!e) return null;
  const rows = await q.all<QcmItemRow>(`SELECT * FROM qcm_items WHERE exam_id = ? ORDER BY idx`, examId);
  const items: QcmItem[] = rows.map((r) => {
    let fig: { spec?: FigureSpec; file?: string; truth?: Record<string, number> } = {};
    try { fig = r.figure_json ? JSON.parse(r.figure_json) : {}; } catch {}
    return {
      topic: r.topic, type: r.type, stem: r.stem, options: JSON.parse(r.options_json), correct: JSON.parse(r.correct_json),
      misconceptions: JSON.parse(r.misconceptions_json ?? "[]"), explanation: rowExplanation(r), verified: r.verified,
      mold: r.mold ?? null, figureSpec: fig.spec ?? null, figureFile: fig.file ?? null, figureTruth: fig.truth ?? null,
    };
  });
  await q.ensureTable("exam_questions");
  const open = (await q.all<QcmOpenRow>(`SELECT id, concept, statement_html, solution_html FROM exam_questions WHERE exam_id = ? AND source_inspiration = 'qcm-open' ORDER BY id`, examId))
    .map((r) => ({ category: "", concept: r.concept, statement_tex: r.statement_html ?? "", solution_tex: r.solution_html ?? "", points: 15 }));
  const { buildQcmArtifact } = await import("@/lib/qcm-latex");
  const out = await buildQcmArtifact(examId, { items, open }, String(e.created_at ?? nowStr()).slice(0, 10));
  if (out.file) await q.run(`UPDATE exams SET html_path = ? WHERE id = ?`, out.file, examId);
  return out;
}

/** Rattrapage : recompile les examens QCM du cours courant restés sans PDF (sans le modèle). */
export async function recompileMissingQcmPdfs(): Promise<{ examId: number; file: string; texError?: string }[]> {
  await ensureQcmSchema();
  const rows = await q.all<{ id: number }>(`SELECT id FROM exams WHERE format_template = 'qcm' AND (html_path IS NULL OR html_path NOT LIKE '%.pdf') ORDER BY id`);
  const out: { examId: number; file: string; texError?: string }[] = [];
  for (const r of rows) {
    const res = await recompileQcmPdf(Number(r.id));
    if (res) out.push({ examId: Number(r.id), file: res.file, ...(res.texError ? { texError: res.texError } : {}) });
  }
  return out;
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
  rationale_json?: string | null;
};

/** Corrige des réponses {idx: number[]} contre la clé connue → score + détail. */
export async function gradeQcm(examId: number, answers: Record<number, number[]>): Promise<{ score: number; total: number; detail: QcmGradeDetail[] }> {
  await ensureQcmSchema();
  const rows = await q.all<QcmGradeRow>(`SELECT idx, options_json, correct_json, explanation, misconceptions_json, rationale_json FROM qcm_items WHERE exam_id = ? ORDER BY idx`, examId);
  const detail = rows.map((r) => {
    const correct: number[] = JSON.parse(r.correct_json);
    const optionCount = (JSON.parse(r.options_json) as unknown[]).length;
    const chosen = [...new Set((answers[r.idx] ?? []).filter((value) => Number.isInteger(value) && value >= 0 && value < optionCount))].sort((a, b) => a - b);
    const ok = JSON.stringify(correct.slice().sort()) === JSON.stringify(chosen);
    const points = scoreQcmAnswer(correct, chosen, optionCount);
    return { idx: r.idx, correct, chosen, ok, points, explanation: rowExplanation(r), misconceptions: JSON.parse(r.misconceptions_json) };
  });
  return { score: detail.reduce((sum, item) => sum + item.points, 0), total: rows.length, detail };
}
