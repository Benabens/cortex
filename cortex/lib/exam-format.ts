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
import { q } from "@/db/q";
import { DEFAULT_COURSE, getCourse } from "@/lib/courses";
import { getFormatProfile, type FormatProfile } from "@/lib/format";

export const EXAM_KINDS = ["qcm", "exercises", "mixed", "essay", "oral"] as const;
export type ExamKind = (typeof EXAM_KINDS)[number];

/** Langues d'un cours ou d'un examen (mêmes codes que la fiche du cours). */
export const LANGUAGES = ["fr", "en", "de", "it", "es", "pt", "nl"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Format DÉCLARÉ par l'étudiant (fiche du cours, app ou connecteur). */
export type DeclaredFormat = {
  kind: ExamKind;
  questionCount: number | null;
  durationMin: number | null;
  /** null = la langue du cours. */
  language: string | null;
};

export class InvalidFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFormatError";
  }
}

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
  /** Une phrase lisible : ce qu'on sait et d'où. */
  summary: string;
  /** Citations des sources quand le format a été déduit hors annales. */
  evidence: string[];
};

export type MockExamRequest = { count?: number | null; focus?: string | null };

/** Style d'un examen à exercices : problèmes (STEM), essai argumenté, oral. */
export type ExerciseStyle = "problems" | "essay" | "oral";

export type MockExamPlan =
  | { generator: "qcm"; qcmCount: number; openCount: number }
  | { generator: "exercises"; style: ExerciseStyle; exerciseCount: number | null }
  | { generator: "none"; reason: string };

const QCM_DEFAULT = 20;
const QCM_MAX = 40;
const MIXED_OPEN_DEFAULT = 2;
const EXERCISES_MAX = 12;

/** Ce qu'il faut déclarer quand rien ne dit la forme de l'épreuve. */
export const FORMAT_UNKNOWN_MESSAGE =
  "Format d'examen inconnu pour ce cours : aucune annale, aucun format déclaré, et rien dans les sources ne décrit la forme de l'épreuve. " +
  "Indique-le avant de générer (type : QCM, exercices, mixte, essai ou oral ; nombre de questions ; durée ; langue) — Cortex ne l'invente pas.";

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

const KIND_LABEL: Record<ExamKind, string> = { qcm: "QCM", exercises: "exercices", mixed: "QCM + questions ouvertes", essay: "essai", oral: "oral" };

/**
 * Valide un format déclaré (app : camelCase, connecteur : snake_case accepté).
 * Absent, null ou vide → null (rien de déclaré). Invalide → InvalidFormatError
 * au message montrable tel quel.
 */
export function parseDeclaredFormat(input: unknown): DeclaredFormat | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new InvalidFormatError("Le format d'examen doit être un objet (type, nombre de questions, durée, langue).");
  const o = input as Record<string, unknown>;
  const kind = typeof o.kind === "string" ? o.kind.trim().toLowerCase() : "";
  if (!(EXAM_KINDS as readonly string[]).includes(kind)) {
    throw new InvalidFormatError(`Type d'examen non reconnu : « ${String(o.kind ?? "")} » (attendu : QCM, exercices, mixte, essai ou oral).`);
  }
  const int = (raw: unknown, label: string, lo: number, hi: number): number | null => {
    if (raw === undefined || raw === null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new InvalidFormatError(`Le ${label} doit être un entier entre ${lo} et ${hi}.`);
    return n;
  };
  const questionCount = int(o.questionCount ?? o.question_count, "nombre de questions", 1, 200);
  const durationMin = int(o.durationMin ?? o.duration_min, "durée (minutes)", 5, 600);
  const rawLang = o.language;
  let language: string | null = null;
  if (rawLang !== undefined && rawLang !== null && rawLang !== "") {
    const l = String(rawLang).trim().toLowerCase();
    if (!(LANGUAGES as readonly string[]).includes(l)) throw new InvalidFormatError(`Langue d'examen non reconnue : « ${String(rawLang)} ».`);
    language = l;
  }
  return { kind: kind as ExamKind, questionCount, durationMin, language };
}

// ───────────────────────────── langue des annales ─────────────────────────────

/** Mots-outils discriminants par langue (les plus fréquents, peu partagés). */
const STOPWORDS: Record<Language, string[]> = {
  fr: ["le", "les", "des", "est", "et", "une", "dans", "pour", "pas", "sur", "qui", "du", "au", "aux", "cette", "sont", "avec", "nous", "vous", "ce", "ces"],
  en: ["the", "and", "of", "to", "is", "in", "that", "for", "are", "with", "this", "be", "on", "as", "by", "which", "an", "it", "what", "each"],
  de: ["der", "die", "das", "und", "ist", "nicht", "mit", "sich", "den", "ein", "eine", "zu", "von", "auf", "für", "dem", "wird"],
  it: ["il", "gli", "di", "che", "è", "per", "non", "con", "sono", "della", "nel", "alla", "delle", "questo", "anche"],
  es: ["el", "los", "las", "y", "por", "para", "del", "se", "como", "más", "es", "una", "su", "lo", "este"],
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

// ───────────────────────────── résolution ─────────────────────────────

/** Le format détecté stocké en base, avec ce que la détection hors annales y ajoute. */
type StoredProfile = FormatProfile & {
  basis?: FormatBasis;
  exam_kind?: ExamKind | null;
  question_count?: number | null;
  open_count?: number | null;
  evidence?: string[];
  language?: string | null;
};

async function annalesText(cap = 8000): Promise<string | null> {
  let rows: { text: string }[] = [];
  try {
    rows = await q.all<{ text: string }>(
      `SELECT i.text FROM items i JOIN sources s ON s.id = i.source_id WHERE s.type IN ('final','midterm') ORDER BY s.id, i.id LIMIT 40`,
    );
  } catch {
    return null;
  }
  if (!rows.length) return null;
  return rows.map((r) => r.text).join("\n").slice(0, cap);
}

/** Format lu dans des annales : mêmes défauts que le générateur QCM historique. */
function fromAnnalesProfile(p: FormatProfile, language: string): ExamFormat {
  const types = p.question_types ?? [];
  const qcmShare = types.filter((t) => t.type === "scq" || t.type === "mcq").reduce((s, t) => s + (t.approx_count || 0), 0);
  const base = { basis: "annales" as const, durationMin: p.duration_min || null, language, summary: p.format_summary || "", evidence: [] };
  if (!p.has_mcq) return { ...base, kind: "exercises", questionCount: null, openCount: null };
  const questionCount = Math.min(20, Math.max(8, qcmShare || 12));
  const openCount = Math.min(3, Math.max(0, types.find((t) => t.type === "open")?.approx_count ?? 2));
  return { ...base, kind: openCount > 0 ? "mixed" : "qcm", questionCount, openCount };
}

function describe(f: Omit<ExamFormat, "summary">): string {
  if (!f.kind) return "Format inconnu";
  const parts = [KIND_LABEL[f.kind]];
  if (f.questionCount) parts.push(`${f.questionCount} ${f.kind === "exercises" || f.kind === "essay" || f.kind === "oral" ? "sujet(s)" : "questions"}`);
  if (f.durationMin) parts.push(`${f.durationMin} min`);
  const from = { annales: "d'après les annales", declared: "déclaré", sample_questions: "d'après les questions d'exemple officielles", course_info: "d'après les infos du cours", unknown: "" }[f.basis];
  return `${parts.join(", ")} (${from}, en ${f.language})`;
}

function make(f: Omit<ExamFormat, "summary">, summary?: string): ExamFormat {
  return { ...f, summary: summary || describe(f) };
}

let memo: { course: string; format: ExamFormat } | null = null;

/**
 * Ce qu'on sait du format d'examen du cours COURANT, et d'où on le sait.
 * Ordre de confiance : annales (format détecté) > format déclaré > annales au
 * format pas encore détecté (comportement historique : exercices) > questions
 * d'exemple officielles > infos de cours > inconnu. La langue est celle du
 * cours, sauf langue déclarée ou annales écrites dans une autre langue.
 */
export async function resolveExamFormat(): Promise<ExamFormat> {
  const courseId = currentCourse();
  const course = getCourse(courseId);
  const declared = course.examFormat;
  const annales = await annalesText();
  const language = declared?.language || (annales ? detectLanguage(annales) : null) || course.language || "fr";
  const stored = (await getFormatProfile().catch(() => null)) as StoredProfile | null;
  const basisOf = (p: StoredProfile) => p.basis ?? "annales";

  let format: ExamFormat;
  if (courseId === DEFAULT_COURSE) {
    // Format historique figé (calcul / trace / figures) : jamais re-détecté.
    format = make({ basis: "annales", kind: "exercises", questionCount: null, openCount: null, durationMin: course.durationMin, language, evidence: [] });
  } else if (annales && stored && basisOf(stored) === "annales") {
    format = fromAnnalesProfile(stored, language);
  } else if (declared) {
    format = make({
      basis: "declared", kind: declared.kind, questionCount: declared.questionCount, openCount: null,
      durationMin: declared.durationMin, language, evidence: [],
    });
  } else if (annales) {
    format = make({ basis: "annales", kind: "exercises", questionCount: null, openCount: null, durationMin: null, language, evidence: [] });
  } else if (stored && (basisOf(stored) === "sample_questions" || basisOf(stored) === "course_info") && stored.exam_kind) {
    format = make({
      basis: basisOf(stored), kind: stored.exam_kind, questionCount: stored.question_count ?? null, openCount: stored.open_count ?? null,
      durationMin: stored.duration_min || null, language, evidence: stored.evidence ?? [],
    });
  } else {
    format = make({ basis: "unknown", kind: null, questionCount: null, openCount: null, durationMin: null, language, evidence: [] }, "Format inconnu");
  }
  memo = { course: courseId, format };
  return format;
}

/**
 * Langue de l'examen, en SYNCHRONE, pour les consignes des profils (construites
 * de façon synchrone au cœur du moteur) : celle de la dernière résolution du
 * cours dans ce process — le worker résout toujours avant de générer —, sinon
 * la langue déclarée, sinon celle du cours.
 */
export function examLanguageFor(courseId: string): string {
  if (memo?.course === courseId) return memo.format.language;
  const c = getCourse(courseId);
  return c.examFormat?.language || c.language || "fr";
}
