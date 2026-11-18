/**
 * FORMAT D'EXAMEN D'UN COURS ET AIGUILLAGE UNIQUE DES EXAMENS BLANCS.
 *
 * Avant ce module, le format (QCM ou exercices) ne se lisait QUE dans les
 * annales : un cours sans annale n'avait pas de format, retombait sur le
 * générateur d'exercices STEM, et le « focus » servait à forcer la forme. Ici :
 *
 *  - `resolveExamFormat()` dit ce qu'on sait du format, et d'où on le sait, par
 *    ordre de confiance : annales > format déclaré > questions d'exemple
 *    officielles > infos de cours (syllabus, Moodle) > inconnu ;
 *  - `planMockExam()` choisit le générateur. Tout examen blanc (app, connecteur
 *    MCP, programme) passe par lui ; le focus reste un accent THÉMATIQUE ;
 *  - un format inconnu n'est jamais inventé : la génération est refusée avec
 *    ce qu'il faut déclarer.
 */

import { currentCourse } from "@/db/client";
import type { SurveyedLayout } from "@/lib/exam-layout-survey";
import { q } from "@/db/q";
import { updateCourseRow } from "@/db/courses-store";
import { DEFAULT_COURSE, getCourse, reloadCourses } from "@/lib/courses";
import { sanitizeCorpus } from "@/lib/prompt-safety";
import { excludedSourceIds, materialLabel } from "@/lib/source-scope";
import { EXAM_HAS_TEXT } from "@/lib/sources";
import { languageName } from "@/lib/profiles/generic-directives";
import type { FormatProfile } from "@/lib/format";
import { UserFacingError, userError, type UserError } from "@/lib/i18n/user-error";

export const EXAM_KINDS = ["qcm", "exercises", "mixed", "composite", "essay", "oral"] as const;
export type ExamKind = (typeof EXAM_KINDS)[number];

/** Langues d'un cours ou d'un examen (mêmes codes que la fiche du cours). */
export const LANGUAGES = ["fr", "en", "de", "it", "es", "pt", "nl"] as const;
export type Language = (typeof LANGUAGES)[number];

/**
 * Réponse unique (SCQ), réponses multiples (MCQ) ou les deux dans un même examen. Le banc
 * HUM-285 du 02/11/2026 avait 7 questions sur 19 à réponses multiples pour un examen à
 * réponse unique : « QCM » ne le disait pas.
 */
export const ANSWER_MODES = ["single", "multiple", "mixed"] as const;
export type AnswerMode = (typeof ANSWER_MODES)[number];

/** Documents permis pendant l'examen : aucun, notes personnelles, tous. */
export const DOCUMENT_RULES = ["none", "notes", "open"] as const;
export type DocumentRule = (typeof DOCUMENT_RULES)[number];

/** Format DÉCLARÉ par l'étudiant (fiche du cours, app ou connecteur). */
export type DeclaredFormat = {
  kind: ExamKind;
  questionCount: number | null;
  durationMin: number | null;
  /** null = la langue du cours. */
  language: string | null;
  /** Absent = rien de déclaré : les sources, sinon la réponse unique. */
  answerMode?: AnswerMode;
  /** Absent = rien de déclaré : la garde de l'examen n'en dit rien. */
  documents?: DocumentRule;
};

export class InvalidFormatError extends UserFacingError {
  constructor(error: UserError) {
    super(error, 400);
    this.name = "InvalidFormatError";
  }
}

/** STEM (problèmes, calcul) ou sciences humaines et sociales (notions, études, argumentation). */
export type Discipline = "stem" | "humanities";

/** D'où vient ce qu'on sait du format, du plus sûr au moins sûr. */
export type FormatBasis = "annales" | "declared" | "sample_questions" | "course_info" | "unknown";

export type ExamFormat = {
  basis: FormatBasis;
  /** null ⇔ format inconnu (basis « unknown »). */
  kind: ExamKind | null;
  /** Nombre de questions (QCM) ou d'exercices ; null = inconnu. */
  questionCount: number | null;
  /** Questions ouvertes d'un examen mixte ; null = inconnu. */
  openCount: number | null;
  durationMin: number | null;
  /** Langue de l'examen (code ISO court). */
  language: string;
  /** Famille de matière : décide des archétypes des questions ouvertes (lib/profiles/generic). */
  discipline: Discipline;
  /** Une phrase lisible : ce qu'on sait et d'où. */
  summary: string;
  /** Citations des sources quand le format a été déduit hors annales. */
  evidence: string[];
  /** Questions composées (kind « composite ») : sections de l'annale modèle, sous-questions par question. */
  blocks?: BlockFormat | null;
  /** Questions à choix (QCM, mixte) : unique, multiples ou les deux ; null pour un autre type. */
  answerMode?: AnswerMode | null;
  /** Options de chaque QCM, lues dans l'annale (2 pour un vrai/faux, 5 pour A–E) ; null = inconnu. */
  optionsPerQuestion?: number | null;
  /** Documents permis que l'annale écrit (détection du format) ; absent : elle ne le dit pas. */
  documents?: DocumentRule | null;
  /** Total de points des annales, quand elles le disent (absent sinon ; un format à questions composées le porte dans `blocks`). */
  totalPoints?: number;
};

/**
 * Format à QUESTIONS COMPOSÉES (mid-term de CS-290, le format le plus courant à l'EPFL) :
 * chaque question est un scénario ou un extrait de code suivi de sous-questions mêlées.
 * `sections` : une par question de l'annale modèle (vide : la couverture des chapitres décide).
 */
export type BlockFormat = { sections: { name: string; description: string }[]; partsMin: number; partsMax: number; totalPoints: number | null };

export type MockExamRequest = { count?: number | null; focus?: string | null };

/** Style d'un examen à exercices : problèmes (STEM), essai argumenté, oral. */
export type ExerciseStyle = "problems" | "essay" | "oral";

export type MockExamPlan =
  | { generator: "qcm"; qcmCount: number; openCount: number }
  | { generator: "blocks"; blockCount: number; partsMin: number; partsMax: number; sections: BlockFormat["sections"]; totalPoints: number | null }
  | { generator: "exercises"; style: ExerciseStyle; exerciseCount: number | null }
  | { generator: "none"; reason: string };

export const QCM_DEFAULT = 20;
/**
 * Borne du nombre de QCM d'un examen blanc, annale comprise (une annale de 60 QCM en donne 40) :
 * au-delà, un job dépasse l'échéance du worker (QCM_MAX_RUNTIME_MIN, 75 min) et son coût le prix.
 */
export const QCM_MAX = 40;
const MIXED_OPEN_DEFAULT = 2;
export const EXERCISES_MAX = 12;
export const BLOCKS_MAX = 10;
const BLOCKS_DEFAULT = 5;
const PARTS_DEFAULT = { partsMin: 3, partsMax: 6 };
/** Options d'un QCM : de 2 (vrai/faux) à 8 (lettres A à H du rendu, lib/qcm-latex). */
export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 8;

/** Types de sources qui parlent de l'EXAMEN (annales, exemples officiels, consignes), pas de la matière. */
export const EXAM_SOURCE_TYPES = ["final", "midterm", "sample_questions", "exam_info"] as const;

/** Ce qu'il faut déclarer quand rien ne dit la forme de l'épreuve. */
export const FORMAT_UNKNOWN_MESSAGE =
  "Format d'examen inconnu pour ce cours : aucune annale, aucun format déclaré, et rien dans les sources ne décrit la forme de l'épreuve. " +
  "Indique-le avant de générer (type : QCM, exercices, mixte, essai ou oral ; nombre de questions ; durée ; langue). Cortex ne l'invente pas.";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(n)));
const positive = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * Choisit le générateur d'un examen blanc. Pur : le format vient de
 * `resolveExamFormat`, la demande de l'appelant (nombre, focus). Le focus est
 * un accent thématique, il ne change jamais le générateur ni le nombre.
 */
export function planMockExam(format: ExamFormat, req: MockExamRequest): MockExamPlan {
  const asked = positive(req.count) ? req.count : null;
  switch (format.kind) {
    case "qcm":
    case "mixed": {
      const qcmCount = clamp(asked ?? (positive(format.questionCount) ? format.questionCount : QCM_DEFAULT), 1, QCM_MAX);
      const openCount = format.kind === "mixed"
        ? (typeof format.openCount === "number" && format.openCount >= 0 ? Math.min(6, format.openCount) : MIXED_OPEN_DEFAULT)
        : 0;
      return { generator: "qcm", qcmCount, openCount };
    }
    case "composite": {
      const b = format.blocks ?? { sections: [], ...PARTS_DEFAULT, totalPoints: null };
      const blockCount = clamp(asked ?? (positive(format.questionCount) ? format.questionCount : b.sections.length || BLOCKS_DEFAULT), 1, BLOCKS_MAX);
      return { generator: "blocks", blockCount, partsMin: b.partsMin, partsMax: b.partsMax, sections: b.sections, totalPoints: b.totalPoints };
    }
    case "exercises": {
      const n = asked ?? (positive(format.questionCount) ? format.questionCount : null);
      return { generator: "exercises", style: "problems", exerciseCount: n === null ? null : clamp(n, 1, EXERCISES_MAX) };
    }
    case "essay":
      return { generator: "exercises", style: "essay", exerciseCount: clamp(asked ?? (positive(format.questionCount) ? format.questionCount : 2), 1, EXERCISES_MAX) };
    case "oral":
      return { generator: "exercises", style: "oral", exerciseCount: clamp(asked ?? (positive(format.questionCount) ? format.questionCount : 3), 1, EXERCISES_MAX) };
    default:
      return { generator: "none", reason: FORMAT_UNKNOWN_MESSAGE };
  }
}

// ───────────────────────────── format déclaré ─────────────────────────────

const KIND_LABEL: Record<ExamKind, string> = { qcm: "QCM", exercises: "exercices", mixed: "QCM + questions ouvertes", composite: "questions composées (scénario + sous-questions)", essay: "essai", oral: "oral" };

/**
 * Valide un format déclaré (app : camelCase, connecteur : snake_case accepté).
 * Absent, null ou vide → null (rien de déclaré). Invalide → InvalidFormatError
 * au message montrable tel quel.
 */
export function parseDeclaredFormat(input: unknown): DeclaredFormat | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new InvalidFormatError(userError("exam_format_object_required"));
  const o = input as Record<string, unknown>;
  const kind = typeof o.kind === "string" ? o.kind.trim().toLowerCase() : "";
  if (!(EXAM_KINDS as readonly string[]).includes(kind)) {
    throw new InvalidFormatError(userError("exam_format_kind_unknown", { kind: String(o.kind ?? "") }));
  }
  const int = (raw: unknown, code: "exam_format_question_count_invalid" | "exam_format_duration_invalid", lo: number, hi: number): number | null => {
    if (raw === undefined || raw === null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new InvalidFormatError(userError(code, { lo, hi }));
    return n;
  };
  const questionCount = int(o.questionCount ?? o.question_count, "exam_format_question_count_invalid", 1, 200);
  const durationMin = int(o.durationMin ?? o.duration_min, "exam_format_duration_invalid", 5, 600);
  const rawLang = o.language;
  let language: string | null = null;
  if (rawLang !== undefined && rawLang !== null && rawLang !== "") {
    const l = String(rawLang).trim().toLowerCase();
    if (!(LANGUAGES as readonly string[]).includes(l)) throw new InvalidFormatError(userError("exam_format_language_unknown", { language: String(rawLang) }));
    language = l;
  }
  const rawMode = o.answerMode ?? o.answer_mode;
  let answerMode: AnswerMode | null = null;
  if (rawMode !== undefined && rawMode !== null && rawMode !== "") {
    const m = String(rawMode).trim().toLowerCase();
    if (!(ANSWER_MODES as readonly string[]).includes(m)) throw new InvalidFormatError(userError("exam_format_answer_mode_unknown", { mode: String(rawMode) }));
    answerMode = m as AnswerMode;
  }
  const rawDocs = o.documents;
  let documents: DocumentRule | null = null;
  if (rawDocs !== undefined && rawDocs !== null && rawDocs !== "") {
    const d = String(rawDocs).trim().toLowerCase();
    if (!(DOCUMENT_RULES as readonly string[]).includes(d)) throw new InvalidFormatError(userError("exam_format_documents_unknown", { documents: String(rawDocs) }));
    documents = d as DocumentRule;
  }
  return { kind: kind as ExamKind, questionCount, durationMin, language, ...(answerMode ? { answerMode } : {}), ...(documents ? { documents } : {}) };
}

/** Réponse unique quand rien ne dit le contraire (sans annale, sans déclaration, sources muettes). */
export const DEFAULT_ANSWER_MODE: AnswerMode = "single";

/** Un format à questions à choix, qui a donc un mode de réponse. */
const hasChoices = (kind: ExamKind | null) => kind === "qcm" || kind === "mixed";

/**
 * Mode de réponse lu dans les annales : les types de QCM que la détection y a comptés ; null si
 * elle n'en a compté aucun (la déclaration décide alors, sinon aucune contrainte).
 */
export function annalesAnswerMode(p: Pick<FormatProfile, "question_types">): AnswerMode | null {
  const types = new Set((p.question_types ?? []).map((t) => t.type));
  if (types.has("scq") && types.has("mcq")) return "mixed";
  if (types.has("mcq")) return "multiple";
  return types.has("scq") ? "single" : null;
}

// ───────────────────────────── langue des annales ─────────────────────────────

/** Mots-outils discriminants par langue (les plus fréquents, peu partagés). */
const STOPWORDS: Record<Language, string[]> = {
  fr: ["le", "la", "les", "des", "est", "et", "une", "dans", "pour", "pas", "sur", "qui", "du", "au", "aux", "cette", "sont", "avec", "nous", "vous", "ce", "ces", "leurs"],
  en: ["the", "and", "of", "to", "is", "in", "that", "for", "are", "with", "this", "be", "on", "as", "by", "which", "an", "it", "what", "each"],
  de: ["der", "die", "das", "und", "ist", "nicht", "mit", "sich", "den", "ein", "eine", "zu", "von", "auf", "für", "dem", "wird"],
  it: ["il", "gli", "di", "che", "è", "per", "non", "con", "sono", "della", "nel", "alla", "delle", "questo", "anche"],
  // « la », « que », « en » : parmi les plus fréquents de l'espagnol ; sans eux, « de » et « en »
  // donnaient le néerlandais (audit ingestion du 16/11/2026).
  es: ["el", "la", "los", "las", "y", "que", "en", "por", "para", "del", "se", "como", "más", "es", "una", "su", "lo", "este", "al", "sus", "entre", "pero", "cuando", "también", "hay", "está"],
  pt: ["o", "os", "as", "e", "do", "da", "dos", "das", "em", "não", "uma", "para", "com", "que", "ao"],
  nl: ["de", "het", "een", "en", "van", "is", "niet", "met", "op", "voor", "zijn", "dat", "die", "wordt"],
};

/**
 * Langue dominante d'un texte, par comptage de mots-outils. null si le texte
 * est trop court ou trop mêlé pour trancher : on ne devine pas.
 */
export function detectLanguage(text: string): Language | null {
  const words = text.toLowerCase().normalize("NFC").match(/[\p{L}]+/gu) ?? [];
  if (words.length < 20) return null;
  const counts = new Map<Language, number>();
  for (const lang of LANGUAGES) {
    const set = new Set(STOPWORDS[lang]);
    counts.set(lang, words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0));
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (best[1] < 5 || best[1] < second[1] * 1.4) return null;
  return best[0];
}

// ───────────────────────────── discipline ─────────────────────────────

/**
 * Préfixes de code de cours sans ambiguïté (EPFL et usages courants des universités américaines,
 * britanniques et françaises), suivis du numéro, collé ou non : « CS-202 », « MATH 221 », « CS201 »,
 * « COMP0002 », « HIST0001 », « ENGL 101 ». Avant le 18/11/2026, ENGL, PSYC ou LING tombaient en
 * « stem » sans corpus pour trancher (audit du 16/11, P1-8). ECON reste au corpus : selon le cours,
 * c'est de la prose ou du calcul.
 */
const HUMANITIES_CODE = /^(HUM|SHS|MGT|DH|AR|LAW|PHIL|HIST|SOC|SOCI|POL|POLS|POLI|LIT|ENGL|LING|ANTH|PSYC|PSYCH|REL|RELS|RELI|CLAS|CLASS|MUS|MUSI|ARTH|ARTS|THEA|EDUC|FREN|GERM|SPAN|ITAL|LATN|HUMN|HUMS|AMST|GEND)(?=[\s_-]*\d)/i;
const STEM_CODE = /^(MATH|MAT|MTH|AMATH|APMA|PHYS|PHY|CS|CSC|CSCI|CPSC|CMSC|CSE|CIS|COM|COMP|COMPSCI|EE|ECE|EECS|ELEC|ME|MECH|MAE|AERO|ENGR|CH|CHE|CHM|CHEM|BIO|BIOL|BIOENG|MSE|CIVIL|ENV|MICRO|NX|STA|STAT|STATS|ORIE|IEOR|ASTR|GEOL|FIN)(?=[\s_-]*\d)/i;
/** Symboles et motifs de calcul : leur densité sépare un polycopié de maths d'un cours de SHS. */
const MATH_TOKEN = /[=^∑∫√≤≥≈∂∇λσμπθ±×÷]|\d(?:[.,]\d+)?\s*[-+*/]\s*\(?\d|\\(?:frac|sum|int|sqrt|alpha|beta|lambda|sigma|mathbb)\b/g;
const MATH_PER_1000 = 4;
/** Début d'un mot du nom du cours (`\b` ignore les lettres accentuées : « Électronique »). */
const nameWord = (stems: string) => new RegExp(`(?<!\\p{L})(?:${stems})`, "iu");
const HUMANITIES_NAME = nameWord("histor|histoire|geschicht|storia|literat|littérat|philosoph|sociolog|psycholog|anthropolog|linguisti|politi|droit|law\\b|theolog|théolog|religio|ethic|éthique|musi|art history|histoire de l'art|classics|humanit");
const STEM_NAME = nameWord("math|calcul|algebr|algèbr|geometr|géométr|probabil|statisti|physi|chemi|chimi|biolog|informati|comput|programm|algorith|data|machine learning|electron|électron|circuit|signal|mechani|mécani|engineer|ingénier|thermodynam|optimi|numeric|numériq|crypto");

/**
 * Famille de matière d'un cours : le code tranche quand il est clair, puis le nom du cours quand il
 * ne relève que d'une famille, puis la densité de notation mathématique de son corpus. Sans rien
 * pour trancher : STEM, le comportement historique du moteur.
 */
export function inferDiscipline(c: { code?: string | null; name?: string | null; sample?: string | null }): Discipline {
  const code = (c.code ?? "").trim();
  if (HUMANITIES_CODE.test(code)) return "humanities";
  if (STEM_CODE.test(code)) return "stem";
  const name = c.name ?? "";
  const humanitiesName = HUMANITIES_NAME.test(name);
  if (humanitiesName !== STEM_NAME.test(name)) return humanitiesName ? "humanities" : "stem";
  const text = c.sample ?? "";
  if (text.length < 300) return "stem";
  const density = (text.match(MATH_TOKEN)?.length ?? 0) / (text.length / 1000);
  return density >= MATH_PER_1000 ? "stem" : "humanities";
}

/**
 * Titres LISIBLES des supports de cours (hors annales, exemples, consignes, sources hors programme,
 * noms de fichiers), à défaut de notions
 * analysées. Un titre vient d'un nom de fichier ou d'une balise <title> : assaini et
 * borné avant d'entrer dans un prompt (il n'est pas encadré comme donnée).
 */
export async function courseMaterialTitles(): Promise<string[]> {
  try {
    const rows = await q.all<{ id: number | string; title: string }>(
      `SELECT s.id, s.title FROM sources s WHERE s.type NOT IN (${EXAM_SOURCE_TYPES.map(() => "?").join(",")}) ORDER BY s.recency_weight DESC, s.id`,
      ...EXAM_SOURCE_TYPES,
    );
    // Ni une source hors programme, ni une archive d'organisation (thèmes des posters) : pas un sujet.
    const excluded = await excludedSourceIds();
    // Jamais un nom de fichier (« S_ance_1_…_slides_01.00.md ») : il devenait le sujet affiché d'un QCM (job 14 de HUM-285).
    const titles = rows.filter((r) => !excluded.has(Number(r.id))).map((r) => materialLabel(sanitizeCorpus(r.title).replace(/\s+/g, " ").trim().slice(0, 120)));
    return [...new Set(titles.filter((t): t is string => !!t))];
  } catch {
    return [];
  }
}

async function corpusSample(cap = 30_000): Promise<string> {
  try {
    const rows = await q.all<{ text: string }>(
      `SELECT i.text FROM items i JOIN sources s ON s.id = i.source_id WHERE s.type NOT IN ('final','midterm') ORDER BY s.recency_weight DESC, s.id, i.id LIMIT 200`,
    );
    return rows.map((r) => r.text).join("\n").slice(0, cap);
  } catch {
    return "";
  }
}

// ───────────────────────────── résolution ─────────────────────────────

/** Le format détecté stocké en base, avec ce que la détection hors annales y ajoute (lib/format). */
export type StoredProfile = FormatProfile & {
  basis?: FormatBasis;
  exam_kind?: ExamKind | null;
  question_count?: number | null;
  open_count?: number | null;
  evidence?: string[];
  /** Questions d'exemple officielles citées mot pour mot (style, sans annale). */
  examples?: string[];
  /** Mode de réponse que les sources disent (sans annale) ; absent ou null = elles ne le disent pas. */
  answer_mode?: AnswerMode | null;
  /** Mise en page relevée dans l'annale à la préparation (lib/exam-layout-survey) ; absent = défaut neutre. */
  layout?: SurveyedLayout;
};

/** Dernier profil détecté (lu ici plutôt que via lib/format, qui dépend de ce module). */
export async function readStoredProfile(): Promise<StoredProfile | null> {
  try {
    await q.ensureTable("format_profile");
    const r = await q.get<{ json: string }>(`SELECT json FROM format_profile ORDER BY id DESC LIMIT 1`);
    return r ? (JSON.parse(r.json) as StoredProfile) : null;
  } catch {
    return null;
  }
}

/** Annales ingérées (finals, partiels) : leur nombre, et un échantillon de leur texte pour la langue. */
async function annales(cap = 8000): Promise<{ count: number; text: string }> {
  try {
    const n = await q.get<{ n: number }>(`SELECT count(*) n FROM sources WHERE type IN ('final','midterm') AND ${EXAM_HAS_TEXT}`);
    const count = Number(n?.n ?? 0);
    if (!count) return { count, text: "" };
    const rows = await q.all<{ text: string }>(
      `SELECT i.text FROM items i JOIN sources s ON s.id = i.source_id WHERE s.type IN ('final','midterm') ORDER BY s.id, i.id LIMIT 40`,
    );
    return { count, text: rows.map((r) => r.text).join("\n").slice(0, cap) };
  } catch {
    return { count: 0, text: "" };
  }
}

/**
 * Questions composées lues dans un profil : le champ de la détection, sinon (profils détectés
 * avant lui, CS-290 du 01/11) des sections et un résumé qui annonce « 3 à 6 sous-questions ».
 * Seulement avec des questions à choix : le générateur de blocs mêle choix unique, réponse
 * courte et lecture de code ; un problème de calcul ou de preuve à sous-questions (STEM)
 * reste un exercice.
 */
export function blocksOf(p: Pick<FormatProfile, "format_summary" | "sections" | "total_points" | "composite" | "has_mcq">): (BlockFormat & { count: number }) | null {
  if (!p.has_mcq) return null;
  const sections = (p.sections ?? []).filter((s) => s?.name).map((s) => ({ name: String(s.name), description: String(s.description ?? "") }));
  const totalPoints = positive(p.total_points) ? p.total_points : null;
  const c = p.composite;
  if (c && positive(c.block_count)) {
    const lo = clamp(positive(c.parts_min) ? c.parts_min : PARTS_DEFAULT.partsMin, 2, 8);
    return { count: clamp(c.block_count, 1, BLOCKS_MAX), sections: sections.slice(0, BLOCKS_MAX), partsMin: lo, partsMax: clamp(positive(c.parts_max) ? c.parts_max : lo, lo, 8), totalPoints };
  }
  const text = [p.format_summary, ...sections.map((s) => s.description)].join(" ");
  const m = /(\d)\s*(?:à|a|-|–|to)\s*(\d)\s*(?:sous-questions|sub-?questions)/i.exec(text);
  if (!m || sections.length < 2) return null;
  const lo = clamp(Number(m[1]), 2, 8);
  return { count: Math.min(sections.length, BLOCKS_MAX), sections: sections.slice(0, BLOCKS_MAX), partsMin: lo, partsMax: clamp(Number(m[2]), lo, 8), totalPoints };
}

/** Nombre d'options d'un profil détecté, s'il est plausible ; sinon null (inconnu). */
function optionsOf(p: Pick<FormatProfile, "options_per_question">): number | null {
  const n = p.options_per_question;
  return typeof n === "number" && Number.isInteger(n) && n >= OPTIONS_MIN && n <= OPTIONS_MAX ? n : null;
}

/** Format lu dans des annales. `declared` : la déclaration du cours, pour ce que les annales ne disent pas (mode, durée). */
function fromAnnalesProfile(p: FormatProfile, language: string, discipline: Discipline, declared: DeclaredFormat | null): ExamFormat {
  const types = p.question_types ?? [];
  const qcmShare = types.filter((t) => t.type === "scq" || t.type === "mcq").reduce((s, t) => s + (t.approx_count || 0), 0);
  const documents = (DOCUMENT_RULES as readonly string[]).includes(p.documents ?? "") ? (p.documents as DocumentRule) : null;
  // Durée déclarée (l'épreuve de cette année), sinon celle de l'annale ; illisible (0) = inconnue (audit 3, P1-3).
  const base = { basis: "annales" as const, durationMin: declared?.durationMin || p.duration_min || null, language, discipline, summary: p.format_summary || "", evidence: [], documents, ...(positive(p.total_points) ? { totalPoints: p.total_points } : {}) };
  const composite = blocksOf(p);
  if (composite) {
    const { count, ...blocks } = composite;
    return { ...base, kind: "composite", questionCount: count, openCount: null, blocks };
  }
  if (!p.has_mcq) return { ...base, kind: "exercises", questionCount: null, openCount: null };
  // Le nombre de l'annale, borné à QCM_MAX seulement (audit 3, P0-4 : une annale de 40 QCM
  // sortait en 20, un quiz de 5 en 8) ; inconnu → le défaut du plan.
  const questionCount = qcmShare > 0 ? clamp(qcmShare, 1, QCM_MAX) : null;
  // Les questions écrites de l'annale (ouvertes, calcul, preuve) deviennent des ouvertes ; aucune
  // n'est inventée : une annale qui n'en a pas donne un examen 100 % QCM.
  const written = types.filter((t) => t.type === "open" || t.type === "calc" || t.type === "proof").reduce((s, t) => s + (t.approx_count || 0), 0);
  const openCount = Math.min(3, Math.max(0, written));
  const kind = openCount > 0 ? "mixed" : "qcm";
  const answerMode = annalesAnswerMode(p) ?? declared?.answerMode ?? "mixed";
  return { ...base, kind, questionCount, openCount, answerMode, optionsPerQuestion: optionsOf(p), summary: withAnswerMode(base.summary, answerMode) };
}

const ANSWER_LABEL: Record<AnswerMode, string> = { single: "à réponse unique", multiple: "à réponses multiples", mixed: "à réponse unique ou multiple" };

/** Le résumé d'un format à choix dit son mode de réponse (sauf s'il le dit déjà). */
function withAnswerMode(summary: string, mode: AnswerMode | null | undefined): string {
  if (!mode || !summary || /réponses? (?:unique|multiples?)/i.test(summary)) return summary;
  return `${summary}, ${ANSWER_LABEL[mode]}`;
}

function describe(f: Omit<ExamFormat, "summary">): string {
  if (!f.kind) return "Format inconnu";
  const choices = f.answerMode && hasChoices(f.kind) ? `QCM ${ANSWER_LABEL[f.answerMode]}` : null;
  const parts = [choices ? (f.kind === "mixed" ? `${choices} + questions ouvertes` : choices) : KIND_LABEL[f.kind]];
  if (f.kind === "composite") parts[0] = `${f.questionCount ? `${f.questionCount} ` : ""}questions composées (scénario + ${f.blocks ? `${f.blocks.partsMin} à ${f.blocks.partsMax}` : "plusieurs"} sous-questions)`;
  else if (f.questionCount) parts.push(`${f.questionCount} ${f.kind === "exercises" || f.kind === "essay" || f.kind === "oral" ? "sujet(s)" : "questions"}`);
  if (f.durationMin) parts.push(`${f.durationMin} min`);
  const from = { annales: "d'après les annales", declared: "déclaré", sample_questions: "d'après les questions d'exemple officielles", course_info: "d'après les infos du cours", unknown: "" }[f.basis];
  return `${parts.join(", ")} (${from}, en ${f.language})`;
}

function make(f: Omit<ExamFormat, "summary">, summary?: string): ExamFormat {
  return { ...f, summary: summary || describe(f) };
}

/**
 * Dernier format résolu, PAR COURS, dans ce process. L'identifiant d'un cours est unique
 * et appartient à un seul compte : rien ne passe d'un compte à l'autre. Borné : le
 * serveur Next vit longtemps et sert beaucoup de cours.
 */
const memo = new Map<string, ExamFormat>();
const MEMO_MAX = 500;

/**
 * Ce qu'on sait du format d'examen du cours COURANT, et d'où on le sait.
 * Ordre de confiance : annales (format détecté) > format déclaré > annales au
 * format pas encore détecté (comportement historique : exercices) > questions
 * d'exemple officielles > infos de cours > inconnu. La langue est celle du
 * cours, sauf langue déclarée, ou annales (à défaut, supports) écrits dans une autre langue.
 */
export async function resolveExamFormat(): Promise<ExamFormat> {
  const courseId = currentCourse();
  const course = getCourse(courseId);
  const declared = course.examFormat;
  const past = await annales();
  const hasAnnales = past.count > 0;
  // Langue : déclarée > celle des annales > celle du cours > celle des supports > anglais. Un cours
  // créé sans langue (« ») garde celle qu'on détecte. Le « fr » posé par défaut à la création avant
  // cette détection ne vaut pas déclaration : les supports passent devant (un cours espagnol créé
  // sans langue sortait ses examens en français).
  const sample = await corpusSample();
  const fromAnnales = past.text ? detectLanguage(past.text) : null;
  const fromMaterials = detectLanguage(sample);
  const detected = fromAnnales || fromMaterials;
  if (!course.language && detected) await keepCourseLanguage(courseId, detected);
  const courseLanguage = course.language && course.language !== "fr" ? course.language : null;
  const language = declared?.language || fromAnnales || courseLanguage || fromMaterials || course.language || FALLBACK_LANGUAGE;
  const stored = await readStoredProfile();
  const discipline = inferDiscipline({ code: course.examCode, name: course.examName, sample });
  const basisOf = (p: StoredProfile) => p.basis ?? "annales";

  let format: ExamFormat;
  if (courseId === DEFAULT_COURSE) {
    // Format historique figé (calcul / trace / figures) : jamais re-détecté.
    format = make({ basis: "annales", kind: "exercises", questionCount: null, openCount: null, durationMin: course.durationMin, language, discipline: "stem", evidence: [] });
  } else if (hasAnnales && stored && basisOf(stored) === "annales") {
    format = fromAnnalesProfile(stored, language, discipline, declared);
  } else if (declared) {
    // Mode non déclaré : celui que disent les sources (détection sans annale), sinon réponse unique.
    const fromSources = stored && basisOf(stored) !== "annales" ? stored.answer_mode : null;
    format = make({
      basis: "declared", kind: declared.kind, questionCount: declared.questionCount, openCount: null,
      durationMin: declared.durationMin, language, discipline, evidence: [],
      ...(declared.kind === "composite" ? { blocks: { sections: [], ...PARTS_DEFAULT, totalPoints: null } } : {}),
      answerMode: hasChoices(declared.kind) ? declared.answerMode ?? fromSources ?? DEFAULT_ANSWER_MODE : null,
    });
  } else if (hasAnnales) {
    format = make({ basis: "annales", kind: "exercises", questionCount: null, openCount: null, durationMin: null, language, discipline, evidence: [] });
  } else if (stored && (basisOf(stored) === "sample_questions" || basisOf(stored) === "course_info") && stored.exam_kind) {
    const blocks = stored.exam_kind === "composite" ? blocksOf(stored) : null;
    format = make({
      basis: basisOf(stored), kind: stored.exam_kind, questionCount: stored.question_count ?? blocks?.count ?? null, openCount: stored.open_count ?? null,
      durationMin: stored.duration_min || null, language, discipline, evidence: stored.evidence ?? [],
      ...(stored.exam_kind === "composite" ? { blocks: blocks ? { sections: blocks.sections, partsMin: blocks.partsMin, partsMax: blocks.partsMax, totalPoints: blocks.totalPoints } : { sections: [], ...PARTS_DEFAULT, totalPoints: null } } : {}),
      answerMode: hasChoices(stored.exam_kind) ? stored.answer_mode ?? DEFAULT_ANSWER_MODE : null,
    });
  } else {
    format = make({ basis: "unknown", kind: null, questionCount: null, openCount: null, durationMin: null, language, discipline, evidence: [] }, "Format inconnu");
  }
  memo.delete(courseId);
  memo.set(courseId, format);
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!);
  return format;
}

/** Langue d'un cours qui n'en a pas (créé sans langue), sans annale qui la dise. */
const FALLBACK_LANGUAGE = "en";

/**
 * Enregistre la langue détectée d'un cours créé sans langue (l'interface la montre, les rendus
 * synchrones la lisent) ; un échec ne bloque pas la génération.
 */
async function keepCourseLanguage(courseId: string, language: string): Promise<void> {
  await updateCourseRow(courseId, getCourse(courseId).ownerUserId, { language })
    .then(() => reloadCourses())
    .catch((e) => console.warn(`[exam-format] langue détectée (${language}) non enregistrée pour ${courseId} : ${(e as Error).message}`));
}

/**
 * Langue de l'examen, en SYNCHRONE, pour les consignes des profils (construites
 * de façon synchrone au cœur du moteur) : celle de la dernière résolution du
 * cours dans ce process — le worker résout toujours avant de générer —, sinon
 * la langue déclarée, sinon celle du cours.
 */
export function examLanguageFor(courseId: string): string {
  return formatContextFor(courseId).language;
}

/**
 * Nom de la langue du cours courant (« français »), pour les libellés des notions qu'en tire la
 * préparation. Celle de l'examen RÉSOLU (annales, déclaration) : examLanguageFor, synchrone, ne
 * lit que la dernière résolution de ce process ou la fiche du cours.
 */
export async function courseLanguageName(): Promise<string> {
  return languageName(await courseLanguage())[1];
}

/** Code de la langue de l'examen RÉSOLU du cours courant (annales, déclaration, supports). */
export async function courseLanguage(): Promise<string> {
  return (await resolveExamFormat().catch(() => null))?.language ?? examLanguageFor(currentCourse());
}

/**
 * Ce que les profils génériques lisent du format, en SYNCHRONE : la dernière
 * résolution du cours dans ce process, sinon la déclaration, la langue et le
 * code du cours (discipline sans échantillon de corpus).
 */
export function formatContextFor(courseId: string): { kind: ExamKind | null; language: string; discipline: Discipline; durationMin: number | null; documents: DocumentRule | null; totalPoints: number | null } {
  const known = memo.get(courseId);
  const c = getCourse(courseId);
  // Documents permis : la déclaration, sinon ce que l'annale écrit ; jamais deviné.
  const documents = c.examFormat?.documents ?? known?.documents ?? null;
  if (known) return { kind: known.kind, language: known.language, discipline: known.discipline, durationMin: known.durationMin, documents, totalPoints: known.totalPoints ?? known.blocks?.totalPoints ?? null };
  return { kind: c.examFormat?.kind ?? null, language: c.examFormat?.language || c.language || FALLBACK_LANGUAGE, discipline: inferDiscipline({ code: c.examCode, name: c.examName }), durationMin: c.examFormat?.durationMin ?? null, documents, totalPoints: null };
}

/**
 * Barème et durée d'un examen généré : la durée du format résolu (annales, déclaration), sinon
 * celle du cours ; le total des annales s'il est connu, sinon un point par minute (180 points en
 * 3 h, le ratio historique). Plus jamais « ~180 points, 3 h » pour un midterm de 75 min.
 */
export function examBudgetFor(courseId: string): { minutes: number; points: number } {
  const f = formatContextFor(courseId);
  // Budget interne de génération seulement : les gardes lisent `durationOf` et n'affichent jamais
  // ce repli historique quand la durée du format est inconnue.
  const minutes = f.durationMin ?? getCourse(courseId).durationMin ?? 180;
  return { minutes, points: f.totalPoints ?? minutes };
}

/** Durée lisible dans un prompt : « 3 h » en heures pleines, sinon « 75 min ». */
export function durationLabel(min: number): string {
  return min % 60 === 0 ? `${min / 60} h` : `${min} min`;
}

/**
 * Format demandé explicitement pour UN examen (connecteur : `format`). Il l'emporte
 * sur le format du cours, annales comprises : celui-ci n'est qu'un DÉFAUT (job 9 de
 * CS-290 : « QCM seulement » demandé, 3 ouvertes imposées par l'annale mixte). « QCM »
 * demandé = QCM seuls, aucune ouverte ; le nombre de questions du cours reste quand il
 * vaut pour ce type. Appliqué à l'identique au devis, au lancement et dans le worker
 * (la demande voyage dans la cible du job, `kind`).
 */
export function requestedFormat(format: ExamFormat, kind: ExamKind | null | undefined): ExamFormat {
  if (!kind) return format;
  const sameType = kind === "qcm" ? format.kind === "qcm" || format.kind === "mixed" : format.kind === kind;
  return {
    ...format, basis: "declared", kind,
    questionCount: sameType ? format.questionCount : null,
    openCount: kind === "qcm" ? 0 : null,
    blocks: kind === "composite" ? (sameType && format.blocks ? format.blocks : { sections: [], ...PARTS_DEFAULT, totalPoints: null }) : null,
    summary: `${KIND_LABEL[kind]} (demandé pour cet examen, en ${format.language})`,
  };
}

/** Le `kind` d'une cible de job d'examen (JSON), s'il en porte un valide. */
export function targetKind(target: string | null | undefined): ExamKind | null {
  try {
    const k = target ? (JSON.parse(target) as { kind?: unknown }).kind : null;
    return typeof k === "string" && (EXAM_KINDS as readonly string[]).includes(k) ? (k as ExamKind) : null;
  } catch {
    return null;
  }
}

/**
 * Durée de l'épreuve du cours courant, en minutes : celle du format résolu (annale, sinon
 * déclaration ; CS-202 : sa fiche). null = inconnue : la garde n'en écrit aucune, jamais de
 * défaut (audit 3, P1-3 et P1-4 : « 180 minutes » pour un QCM déclaré de 75).
 */
export async function examDurationMin(): Promise<number | null> {
  const known = await resolveExamFormat().catch(() => null);
  return durationOf(known ?? formatContextFor(currentCourse()));
}

/** La durée d'un format, si elle est connue (0 ou absente : inconnue). */
export function durationOf(f: { durationMin: number | null }): number | null {
  return positive(f.durationMin) ? f.durationMin : null;
}

/** true si l'examen blanc du cours courant part au générateur QCM (QCM ou mixte). */
export async function isQcmCourse(): Promise<boolean> {
  return planMockExam(await resolveExamFormat(), {}).generator === "qcm";
}
