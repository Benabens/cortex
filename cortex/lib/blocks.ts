import { currentCourse } from "@/db/client";
import { nowStr, q } from "@/db/q";
import { examSummaryLabel } from "@/lib/exam-summary";
import { getCourse } from "@/lib/courses";
import { COURSE_MATTER_RULE, COURSE_TERMS_RULE, evidencePassages } from "@/lib/course-grounding";
import { assignChapters, spreadOverChapters } from "@/lib/coverage";
import type { StepCb } from "@/lib/exam";
import { BLOCK_PART_KINDS, examLanguageFor, type BlockFormat, type BlockPartKind, type PartShape } from "@/lib/exam-format";
import { HARD_STOP_CODES, hardTaskEffort, completeJson, llmErrorCode, llmFailureReason } from "@/lib/llm";
import { languageName } from "@/lib/profiles/generic-directives";
import { untypesetChars } from "@/lib/tex-escape";
import { DATA_RULE, dataBlock, sanitizeCorpus } from "@/lib/prompt-safety";
import { FORMULA_RULE } from "@/lib/tex-rich";
import { NO_FLAG, coverageTopics, runPool } from "@/lib/qcm";
import { examsDir } from "@/lib/paths";
import { PhaseProgress, phaseLine } from "@/lib/progress";
import { runPython } from "@/lib/sandbox-exec";
import { normalize, tokenize } from "@/lib/text";
import { sectionLabel } from "@/lib/section-label";
import { findOverlaps, type Overlap } from "@/lib/block-overlap";
import path from "node:path";
import { storage } from "@/lib/storage";

/**
 * QUESTIONS COMPOSÉES — le format d'examen le plus courant à l'EPFL (mid-term de CS-290) :
 * chaque question est un court scénario, des données ou un extrait de code, suivi de
 * sous-questions qui s'y rapportent toutes et mêlent :
 *  - choix unique (4 options, une seule juste) ;
 *  - réponse courte (1 à 3 phrases), avec un BARÈME de critères fixé à la génération, sur
 *    lequel la correction se fait critère par critère ;
 *  - lecture de code : prédire la sortie exacte d'un extrait Python (jamais en écrire).
 *
 * Le format enregistré pilote tout (lib/exam-format : annale modèle ou set_exam_format) :
 * nombre de questions, sous-questions par question, une section par question. Fidélité
 * au cours : extraits du cours dans chaque demande, puis un juge à l'aveugle (clé du choix
 * unique, sortie du code, définitions du cours) ; la sortie d'un extrait est celle de son
 * exécution dans le bac à sable quand il est disponible. Un bloc rejeté est régénéré avec
 * les reproches du juge ; le nombre demandé est tenu, ou le manque est dit et compté.
 */

export type PartKind = BlockPartKind;
export const PART_KINDS: readonly PartKind[] = BLOCK_PART_KINDS;
export type Criterion = { label: string; points: number };

export type BlockPart = {
  kind: PartKind;
  prompt: string;
  /** Lecture de code : l'extrait Python dont on demande la sortie (vide sinon). */
  code: string;
  /** Choix unique : les options (vide sinon). */
  options: string[];
  /** Choix unique : indice de la bonne option (-1 sinon). */
  correct: number;
  /** Réponse courte : réponse modèle ; lecture de code : sortie exacte. */
  answer: string;
  /** Réponse courte : barème (somme = points). */
  criteria: Criterion[];
  points: number;
  explanation: string;
  /** La sortie attendue est celle de l'exécution du code. */
  codeChecked?: boolean;
};

export type ExamBlock = { title: string; section: string | null; scenario: string; parts: BlockPart[]; points: number; verified: number | null };

/** Contexte commun des demandes ; `others` : les sujets des AUTRES questions de l'examen, à ne pas reprendre. */
type BlockCtx = { system: string; previous: string[]; focus?: string; others?: string[] };

/** Ce qu'un bloc couvre : une section de l'annale modèle, ou une notion du cours. */
type BlockSlot = { theme: string; section: string | null; query: string[]; notions: string[] };

export type BlockPlan = { blockCount: number; partsMin: number; partsMax: number; sections: BlockFormat["sections"]; totalPoints: number | null } & PartShape;

const BLOCK_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Titre court du thème de la question." },
    scenario: { type: "string", description: "Le scénario commun : situation concrète, données ou extrait de code (bloc ```python … ``` si utile)." },
    parts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["scq", "short", "code_output"] },
          prompt: { type: "string" },
          code: { type: "string", description: "code_output : l'extrait autonome, dans le langage de la consigne ; vide sinon." },
          options: { type: "array", items: { type: "string" }, description: "scq : le nombre d'options de la consigne ; vide sinon." },
          correct: { type: "integer", description: "scq : indice de la bonne option ; -1 sinon." },
          answer: { type: "string", description: "short : réponse modèle ; code_output : sortie exacte ; scq : vide." },
          criteria: {
            type: "array",
            description: "short : 1 à 3 critères observables, points entiers, somme = points ; vide sinon.",
            items: { type: "object", properties: { label: { type: "string" }, points: { type: "integer" } }, required: ["label", "points"], additionalProperties: false },
          },
          points: { type: "integer" },
          explanation: { type: "string" },
        },
        required: ["kind", "prompt", "code", "options", "correct", "answer", "criteria", "points", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "scenario", "parts"],
  additionalProperties: false,
} as const;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          answer: { type: "string", description: "scq : la LETTRE de l'option juste ; code_output : la sortie exacte ; short : ta réponse en une ou deux phrases." },
          ok: { type: "boolean", description: "false si la sous-question est ambiguë, sans réponse unique, ou contraire au cours." },
          issue: { type: "string" },
        },
        required: ["index", "answer", "ok", "issue"],
        additionalProperties: false,
      },
    },
    off_course: { type: "string", description: "Toute notion employée absente des extraits du cours ; vide sinon." },
    definition_mismatch: { type: "string", description: "Une définition employée plus étroite, plus large que celle des extraits, ou deux notions voisines confondues : laquelle, ce que dit la question, ce que dit le cours. Vide sinon." },
    trivial_distractors: {
      type: "array",
      description: "Choix unique : les options qu'un étudiant élimine sans connaître le cours.",
      items: { type: "object", properties: { index: { type: "integer" }, options: { type: "array", items: { type: "string" } } }, required: ["index", "options"], additionalProperties: false },
    },
  },
  required: ["verdicts", "off_course", "definition_mismatch", "trivial_distractors"],
  additionalProperties: false,
} as const;

const LETTER = "ABCDEFGH".split("");
const ATTEMPTS = 3;

/** Blocs construits en même temps (BLOCK_CONCURRENCY, défaut 3). */
function blockConcurrency(): number {
  const n = Number(process.env.BLOCK_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 8) : 3;
}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
const text = (s: unknown) => (typeof s === "string" ? s.trim() : "");

/** Ce qui manque à un bloc rendu par le modèle (renvoyé tel quel au modèle), null s'il est conforme. */
export function blockIssue(v: unknown, min: number, max: number, shape: PartShape = {}): string | null {
  const b = v as { scenario?: unknown; parts?: unknown };
  if (!text(b?.scenario)) return "le champ « scenario » (le scénario commun) est vide";
  if (!Array.isArray(b.parts) || b.parts.length < min || b.parts.length > max) {
    return `il faut ${min} à ${max} sous-questions dans « parts » (reçu ${Array.isArray(b.parts) ? b.parts.length : 0})`;
  }
  const parts = b.parts as Partial<BlockPart>[];
  for (const [i, p] of parts.entries()) {
    const at = `sous-question ${LETTER[i].toLowerCase()}`;
    const kinds = shape.kinds ?? PART_KINDS;
    if (!kinds.includes(p?.kind as PartKind)) return shape.kinds && PART_KINDS.includes(p?.kind as PartKind)
      ? `${at} : « ${p.kind} » n'est pas un type de l'annale, emploie seulement ${kinds.join(", ")}`
      : `${at} : « kind » doit valoir ${kinds.slice(0, -1).join(", ")}${kinds.length > 1 ? " ou " : ""}${kinds.at(-1)}`;
    if (!text(p.prompt)) return `${at} : « prompt » est vide`;
    if (!isInt(p.points) || p.points < 1) return `${at} : « points » doit être un entier ≥ 1`;
    const scale = shape.points?.[p.kind as PartKind];
    if (scale && p.points !== scale) return `${at} (${p.kind}) : ${scale} points, comme dans le barème de l'annale (reçu ${p.points})`;
    if (p.kind === "scq") {
      const opts = Array.isArray(p.options) ? p.options : [];
      const empty = opts.some((o) => !text(o));
      if (shape.options ? opts.length !== shape.options || empty : opts.length < 3 || opts.length > 6 || empty) return `${at} (scq) : ${shape.options ? `exactement ${shape.options} options non vides, comme l'annale` : "3 à 6 options non vides (4 de préférence)"}`;
      if (!isInt(p.correct) || p.correct < 0 || p.correct >= opts.length) return `${at} (scq) : « correct » doit être l'indice de la bonne option`;
    } else if (p.kind === "short") {
      const crit = Array.isArray(p.criteria) ? p.criteria : [];
      if (!text(p.answer)) return `${at} (short) : « answer » (la réponse modèle) est vide`;
      if (crit.length < 1 || crit.length > 4 || crit.some((c) => !text(c?.label) || !isInt(c?.points) || c.points < 1)) return `${at} (short) : 1 à 4 critères { label, points entiers ≥ 1 } (3 au plus de préférence)`;
      if (crit.reduce((s, c) => s + c.points, 0) !== p.points) return `${at} (short) : la somme des points des critères doit valoir « points » (${p.points})`;
    } else {
      if (!text(p.code)) return `${at} (code_output) : « code » (l'extrait à lire) est vide`;
      if (!text(p.answer)) return `${at} (code_output) : « answer » (la sortie exacte) est vide`;
    }
  }
  // Tout texte du bloc passe par esc dans le PDF : un caractère qu'il ne sait pas écrire y deviendrait une espace.
  const unprintable = untypesetChars(b);
  if (unprintable.length) return `${unprintable.join(" ")} ne s'imprime pas dans le PDF : écris-le autrement (en toutes lettres)`;
  // Le mélange imposé n'est que le défaut : l'annale dit ses types quand elle les montre.
  if (shape.kinds) {
    if (shape.kinds.length > 1 && new Set(parts.map((p) => p.kind)).size < 2) return `mêle les types de l'annale (${shape.kinds.join(", ")}) : au moins deux d'entre eux`;
  } else if (!parts.some((p) => p.kind === "scq") || !parts.some((p) => p.kind === "short")) return "mêle les types : au moins un choix unique (scq) et au moins une réponse courte (short)";
  return null;
}

/** Une ligne de sortie de programme comparée sans les espaces de fin ni les fins de ligne Windows. */
export function sameOutput(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/\r\n/g, "\n").split("\n").map((l) => l.trimEnd()).join("\n").trim();
  return n(a) === n(b);
}

function seeded(seed: number): () => number {
  let x = seed || 1;
  return () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

function seedOf(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 2 ** 31;
  return h;
}

/** Position de la bonne option mélangée (graine = l'énoncé : reproductible). */
function shuffleOptions(p: BlockPart): BlockPart {
  // Jusqu'à H : l'annale peut avoir 5 options ou plus (P1-12).
  if (p.kind !== "scq" || /\b(?:option|answer|réponse)\s+[A-H]\b/.test(p.explanation)) return p;
  const rnd = seeded(seedOf(p.prompt));
  const order = p.options.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { ...p, options: order.map((i) => p.options[i]), correct: order.indexOf(p.correct) };
}

function cleanPart(p: Partial<BlockPart>): BlockPart {
  const kind = p.kind as PartKind;
  return {
    kind,
    prompt: text(p.prompt),
    code: kind === "code_output" ? String(p.code ?? "").replace(/\s+$/, "") : "",
    options: kind === "scq" ? (p.options ?? []).map((o) => text(o)) : [],
    correct: kind === "scq" ? Number(p.correct) : -1,
    answer: kind === "scq" ? "" : String(p.answer ?? "").trim(),
    criteria: kind === "short" ? (p.criteria ?? []).map((c) => ({ label: text(c.label), points: Number(c.points) })) : [],
    points: Number(p.points),
    explanation: text(p.explanation),
  };
}

// ───────────────────────────── plan des blocs ─────────────────────────────

/** Notions du cours les plus proches d'un texte (mots communs), pour une section de l'annale modèle. */
function nearestNotions(sectionText: string, topics: { label: string; method: string | null }[], k = 4): string[] {
  const want = new Set(tokenize(normalize(sectionText), 4));
  return topics
    .map((t) => ({ t, score: tokenize(normalize(`${t.label} ${t.method ?? ""}`), 4).filter((w) => want.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.t.label);
}

/**
 * Une section qui décrit une FORME (« vrai/faux justifiés », « Question 3 ») ne partage aucun mot
 * avec les notions du cours : sans notion, ses extraits du cours sont pris au hasard du texte de
 * la section, et elle n'a aucune réserve. Prod, 22/11/2026 : une telle section, rejetée trois fois,
 * disparaissait de l'examen (4 questions sur 5). Elle reçoit les notions qu'aucune autre section
 * ne prend, les plus pesées d'abord ; la première guide aussi la recherche d'extraits.
 */
function lendNotions(slots: BlockSlot[], topics: { label: string; weight?: number | null }[]): BlockSlot[] {
  const taken = new Set(slots.flatMap((s) => s.notions));
  const free = [...topics].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).map((t) => t.label).filter((l) => !taken.has(l));
  return slots.map((s) => {
    if (s.notions.length) return s;
    const lent = free.splice(0, 2);
    return lent.length ? { ...s, notions: lent, query: [...s.query, lent[0]] } : s;
  });
}

/** Un bloc par section de l'annale modèle ; sans sections, la couverture des chapitres décide. Plus des réserves. */
async function planSlots(plan: BlockPlan): Promise<{ slots: BlockSlot[]; spares: BlockSlot[] }> {
  const topics = await coverageTopics().catch(() => []);
  if (plan.sections.length) {
    const slots = lendNotions(plan.sections.slice(0, plan.blockCount).map((s) => {
      const theme = s.description ? `${s.name} — ${s.description}` : s.name;
      return { theme, section: s.name, query: [s.name, s.description].filter(Boolean), notions: nearestNotions(theme, topics) };
    }), topics);
    // Plus de questions demandées que de sections : les suivantes reprennent les sections dans
    // l'ordre, recentrées sur une autre de leurs notions (pas deux fois la même question, H).
    for (let i = slots.length; i < plan.blockCount; i++) {
      const s = slots[i % plan.sections.length];
      const nm = s.notions[Math.floor(i / plan.sections.length) % Math.max(1, s.notions.length)];
      slots.push(nm ? { ...s, theme: `${s.theme} — centrée sur : ${nm}`, query: [...s.query, nm] } : { ...s });
    }
    // Réserves : chaque section recentrée sur une de ses notions, pour remplacer un bloc rejeté sans changer de section.
    const spares = slots.slice(0, plan.sections.length).flatMap((s) => s.notions.slice(0, 2).map((nm) => ({ ...s, theme: `${s.theme} — centrée sur : ${nm}`, query: [...s.query, nm] })));
    return { slots, spares };
  }
  const assigned = await assignChapters(topics.map((t) => ({ ...t, weight: t.weight ?? 0 }))).catch(() => []);
  const spread = spreadOverChapters(assigned, plan.blockCount + 2)
    ?? [...topics].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).map((t) => ({ ...t, weight: t.weight ?? 0, chapter: null }));
  const toSlot = (t: { label: string; method: string | null; chapter: string | null; subTheme?: string | null }): BlockSlot => ({
    theme: `${t.label}${t.subTheme ? ` — sous-thème : ${t.subTheme}` : ""}${t.method ? ` [${t.method.slice(0, 200)}]` : ""}`,
    section: t.chapter,
    query: [t.subTheme ? `${t.label} ${t.subTheme}` : t.label],
    notions: assigned.filter((a) => a.chapter && a.chapter === t.chapter && a.label !== t.label).slice(0, 3).map((a) => a.label),
  });
  const slots = spread.slice(0, plan.blockCount).map(toSlot);
  for (let i = slots.length; i < plan.blockCount && slots.length; i++) slots.push({ ...slots[i % slots.length] });
  const used = new Set(slots.map((s) => s.theme));
  const spares = spread.slice(plan.blockCount).filter((t) => !("repeat" in t && t.repeat)).map(toSlot).filter((s) => !used.has(s.theme));
  return { slots, spares };
}

// ───────────────────────────── génération ─────────────────────────────

async function recentBlockPrompts(limit = 30): Promise<string[]> {
  try {
    return (await q.all<{ prompt: string }>(`SELECT prompt FROM block_parts ORDER BY id DESC LIMIT ?`, limit)).map((r) => r.prompt);
  } catch {
    return [];
  }
}

const BAREME: [PartKind, string][] = [["scq", "1 point par choix unique"], ["short", "1 à 3 points par réponse courte"], ["code_output", "1 à 2 points par lecture de code"]];
const PART_NAME: Record<PartKind, string> = { scq: "choix unique", short: "réponse courte", code_output: "lecture de code" };

/** Barème du prompt : celui de l'annale pour un type qu'elle note pareil partout, le défaut sinon. */
const baremeText = (k: PartKind, def: string, points: PartShape["points"]) => {
  const n = points?.[k];
  return n ? `${n} point${n > 1 ? "s" : ""} par ${PART_NAME[k]} (barème de l'annale)` : def;
};

/** Les extraits sont du Python sauf si l'annale en montre d'un autre langage. */
const isPython = (language: string | undefined) => !language || /^(?:python\d?|py)$/.test(language);
const codeName = (language: string) => ({ c: "C", "c++": "C++", cpp: "C++", "c#": "C#", csharp: "C#", java: "Java", javascript: "JavaScript", js: "JavaScript", typescript: "TypeScript", ocaml: "OCaml", scala: "Scala", rust: "Rust", go: "Go", r: "R", matlab: "MATLAB", sql: "SQL", haskell: "Haskell" } as Record<string, string>)[language] ?? language;

/**
 * Deux options, c'est un VRAI/FAUX. Prod, 22/11/2026 : la détection relevait 2 options sur le
 * vrai/faux d'une seule question de l'annale, et tous les choix uniques de l'examen sortaient en
 * A/B, trop faciles. Un vrai/faux reste dans la section qui le décrit ; ailleurs, et quand aucune
 * section n'en décrit un (le nombre relevé peut venir d'une seule question), 4 options plausibles.
 */
const TRUE_FALSE = /vrai\s*(?:\/|ou|-)\s*faux|true\s*(?:\/|or|-)\s*false|richtig\s*(?:\/|oder)\s*falsch|verdadero\s*(?:\/|o)\s*falso|vero\s*(?:\/|o)\s*falso|\bT\/F\b/i;
const choiceOptions = (plan: BlockPlan) => (plan.options && plan.options >= 3 ? plan.options : 4);
const isTrueFalseSlot = (slot: BlockSlot) => TRUE_FALSE.test(slot.theme);

/** Prompt système d'une question composée (exporté pour les tests : tests/prompts-formules). */
export function blockSystemPrompt(plan: BlockPlan, n: number, counterExamples: string): string {
  const c = getCourse(currentCourse());
  const language = languageName(examLanguageFor(currentCourse()))[1];
  // Le barème de l'annale fixe déjà les points de chaque sous-question : un total visé le contredirait.
  const perBlock = plan.totalPoints && !plan.points ? Math.max(3, Math.round(plan.totalPoints / Math.max(1, n))) : null;
  const allows = (k: PartKind) => !plan.kinds || plan.kinds.includes(k);
  const python = isPython(plan.codeLanguage);
  return [
    `Tu es l'équipe enseignante de ${c.examCode} ${c.examName}. Tu rédiges UNE question d'examen COMPOSÉE, au format réel du cours : un court scénario (situation concrète, petites données, ou extrait de code), suivi de ${plan.partsMin} à ${plan.partsMax} sous-questions qui portent toutes sur ce scénario.`,
    plan.kinds
      ? `TYPES DE SOUS-QUESTIONS (ceux de l'annale, aucun autre${plan.kinds.length > 1 ? " ; mêle-les : au moins deux d'entre eux" : ""}) :`
      : `TYPES DE SOUS-QUESTIONS (mêle-les : au moins un choix unique et au moins une réponse courte ; une lecture de code quand le thème s'y prête) :`,
    allows("scq") && `  - "scq" — choix unique : exactement ${choiceOptions(plan)} options${plan.sections.some((x) => TRUE_FALSE.test(`${x.name} ${x.description}`)) ? " (sauf consigne VRAI/FAUX dans la demande d'une question)" : ""}, UNE seule juste ("correct" = son indice). Chaque distracteur est une notion, une définition, une valeur ou une sortie RÉELLEMENT présente dans le cours, légèrement déformée et proche de la bonne réponse — jamais une option générique, absurde ou réfutable par le bon sens. Aucune phrase commune répétée en tête des options. L'explication désigne les options par leur contenu, jamais par leur lettre.`,
    allows("short") && `  - "short" — réponse courte (1 à 3 phrases) : "answer" = la réponse modèle, conforme au cours ; "criteria" = 1 à 3 critères OBSERVABLES dans une copie (ce que la réponse doit nommer ou justifier), chacun avec ses points entiers, leur somme = "points".`,
    allows("code_output") && `  - "code_output" — lecture de code : "code" = un extrait ${python ? "Python" : codeName(plan.codeLanguage!)} AUTONOME et court (bibliothèque standard${python ? " ; pandas seulement si le cours l'emploie" : ""} ; ni fichier, ni réseau, ni hasard, ni horloge), "prompt" demande ce qu'il affiche, "answer" = sa sortie EXACTE, ligne pour ligne. Jamais d'écriture de code.`,
    `  - Chaque sous-question se répond seule à partir du scénario : aucune ne dépend de la réponse d'une autre, aucune ne donne la réponse d'une autre.`,
    COURSE_TERMS_RULE,
    COURSE_MATTER_RULE,
    `  - ${FORMULA_RULE}`,
    `  - Barème : ${BAREME.filter(([k]) => allows(k)).map(([k, t]) => baremeText(k, t, plan.points)).join(", ")}${perBlock ? ` ; environ ${perBlock} points pour la question entière` : ""}.`,
    `Langue de l'examen : ${language} (énoncés, options, réponses et critères).`,
    counterExamples,
    `Réponds UNIQUEMENT avec un objet JSON {"title","scenario","parts":[{"kind","prompt","code","options","correct","answer","criteria":[{"label","points"}],"points","explanation"}]}. Aucune prose autour, aucune balise markdown autour du JSON.`,
  ].filter(Boolean).join("\n");
}

async function generateBlock(slot: BlockSlot, i: number, n: number, plan: BlockPlan, ctx: BlockCtx, guidance: string | null, passages: { src: string; text: string }[]): Promise<ExamBlock> {
  const allows = (k: PartKind) => !plan.kinds || plan.kinds.includes(k);
  const trueFalse = allows("scq") && isTrueFalseSlot(slot);
  const shape: PartShape = { ...plan, options: trueFalse ? 2 : plan.options ? choiceOptions(plan) : undefined };
  const prompt = [
    `QUESTION ${i + 1}/${n}`,
    `THÈME : ${sanitizeCorpus(slot.theme).replace(/\s+/g, " ").slice(0, 400)}`,
    slot.notions.length ? `Notions du cours à mobiliser si elles s'y prêtent : ${slot.notions.map((x) => sanitizeCorpus(x).slice(0, 100)).join(" ; ")}.` : "",
    ctx.focus ? `Accent demandé par l'étudiant (un thème, pas une forme) : « ${sanitizeCorpus(ctx.focus).slice(0, 200)} ».` : "",
    ctx.previous.length ? `Déjà posées dans les examens précédents de ce cours (ne les reprends pas) :\n${ctx.previous.slice(0, 12).map((x) => `  · ${sanitizeCorpus(x).slice(0, 140)}`).join("\n")}` : "",
    // Prod, 22/11/2026 : construites en parallèle, les questions ne se voyaient pas et se recouvraient.
    ctx.others?.length ? `AUTRES QUESTIONS DE CET EXAMEN — leurs sujets ne se reprennent ni dans ton scénario ni dans une sous-question :\n${ctx.others.map((x) => `  · ${sanitizeCorpus(x).replace(/\s+/g, " ").slice(0, 160)}`).join("\n")}` : "",
    trueFalse ? `VRAI/FAUX : chaque "scq" de cette question est une affirmation à juger, exactement 2 options (vrai, faux, dans la langue de l'examen)${allows("short") ? `, suivie d'une sous-question "short" qui demande de justifier` : ""}.` : "",
    guidance ? `VERSION PRÉCÉDENTE REJETÉE — corrige ceci : ${guidance}` : "",
    passages.length ? [DATA_RULE, dataBlock(`EXTRAITS DU COURS — les définitions qui font foi`, passages)].join("\n") : "Aucun extrait du cours n'a été retrouvé pour ce thème : reste sur les notions du programme, sans en inventer.",
    `${plan.partsMin} à ${plan.partsMax} sous-questions. Réponds avec l'objet JSON {"title","scenario","parts":[…]} décrit plus haut.`,
  ].filter(Boolean).join("\n\n");
  const raw = await completeJson<{ title?: string; scenario?: string; parts?: Partial<BlockPart>[] }>(
    { system: ctx.system, prompt, model: "opus", timeoutMs: 300_000, json: { schema: BLOCK_SCHEMA } },
    { check: (v) => blockIssue(v, plan.partsMin, plan.partsMax, shape) },
  );
  const parts = (raw.parts ?? []).map(cleanPart).map(shuffleOptions);
  return { title: sectionLabel(text(raw.title)) ?? sectionLabel(slot.section) ?? "", section: slot.section, scenario: String(raw.scenario ?? "").trim(), parts, points: parts.reduce((s, p) => s + p.points, 0), verified: null };
}

/**
 * Sortie de chaque extrait de code par EXÉCUTION (bac à sable noyau, sinon Pyodide si
 * CORTEX_PYTHON_WASM=1) : elle remplace celle que le modèle a prédite. Bac à sable, Python ou
 * module absents : la prédiction reste, le juge la vérifie. Un extrait qui plante est une
 * erreur du bloc.
 */
async function runCodeParts(b: ExamBlock, language: string | undefined): Promise<string[]> {
  const issues: string[] = [];
  // Seul Python s'exécute ici : la sortie d'un autre langage reste celle du modèle, que le juge vérifie.
  if (!isPython(language)) return issues;
  for (const [i, p] of b.parts.entries()) {
    if (p.kind !== "code_output" || !p.code) continue;
    const r = await runPython(p.code, { timeoutMs: 10_000, cpuSeconds: 5, maxOutputBytes: 8_000 });
    if (r.ok) {
      p.answer = r.stdout.replace(/\s+$/, "");
      p.codeChecked = true;
    } else if (r.reason === "timeout") {
      issues.push(`l'extrait de la sous-question ${LETTER[i].toLowerCase()} ne termine pas`);
    } else if (r.reason === "error" && !/ModuleNotFoundError|ImportError/.test(r.stderr)) {
      issues.push(`l'extrait de la sous-question ${LETTER[i].toLowerCase()} lève une erreur : ${r.stderr.trim().split("\n").pop()?.slice(0, 160) ?? r.reason}`);
    }
  }
  return issues;
}

/** Juge à l'aveugle (sans clé ni barème) : ce qu'il reproche au bloc, vide s'il passe. null : juge indisponible. */
async function judgeBlock(b: ExamBlock, passages: { src: string; text: string }[], language: string | undefined): Promise<string[] | null> {
  const body = b.parts.map((p, i) => [
    `(${LETTER[i].toLowerCase()}) [${p.kind}] ${p.prompt}`,
    p.kind === "code_output" ? "```" + (language ?? "python") + "\n" + p.code + "\n```" : "",
    ...p.options.map((o, k) => `  ${LETTER[k]}. ${o}`),
  ].filter(Boolean).join("\n")).join("\n\n");
  const system = [
    `Tu es un correcteur indépendant. Résous chaque sous-question de cette question d'examen composée, SANS corrigé, avec les DÉFINITIONS DES EXTRAITS DU COURS (jamais celles d'une autre source).`,
    `Pour chaque sous-question (index 0 = a) : "answer" = la lettre de l'option juste (scq), la sortie exacte du code (code_output), ou ta réponse en une ou deux phrases (short) ; ok=false si elle est ambiguë, sans réponse unique, ou contraire au cours, et dis pourquoi dans "issue".`,
    `off_course : toute notion employée absente des extraits. definition_mismatch : une définition employée (scénario, énoncés, options) plus étroite (une condition ajoutée) ou plus large (une condition oubliée) que celle du cours, ou deux notions voisines confondues. trivial_distractors : les options qu'on élimine sans connaître le cours.`,
    `Réponds UNIQUEMENT avec un objet JSON {"verdicts":[{"index","answer","ok","issue"}],"off_course","definition_mismatch","trivial_distractors":[{"index","options"}]}.`,
  ].join("\n");
  const prompt = [
    passages.length ? [DATA_RULE, dataBlock(`EXTRAITS DU COURS — les définitions qui font foi`, passages)].join("\n") : "Aucun extrait du cours fourni.",
    `SCÉNARIO :\n${b.scenario}`,
    `SOUS-QUESTIONS :\n${body}`,
  ].join("\n\n");
  let res: { verdicts?: { index: number; answer: string; ok: boolean; issue?: string }[]; off_course?: string; definition_mismatch?: string; trivial_distractors?: { index: number; options: string[] }[] };
  try {
    // Un verdict par sous-question, sinon rien n'est vérifié (jamais de faux « vérifié »).
    const covers = (v: typeof res) => b.parts.every((_, i) => v.verdicts?.some((x) => x.index === i));
    res = await completeJson({ system, prompt, model: "opus", effort: hardTaskEffort(), timeoutMs: 240_000, json: { schema: VERDICT_SCHEMA } }, {
      check: (v: typeof res) => (!Array.isArray(v?.verdicts) ? "le champ « verdicts » manque" : covers(v) ? null : `un verdict par sous-question (index 0 à ${b.parts.length - 1})`),
    });
  } catch {
    return null;
  }
  const issues: string[] = [];
  const said = (x: unknown) => (passages.length && typeof x === "string" && !NO_FLAG.test(x.trim()) ? x.trim() : "");
  for (const [i, p] of b.parts.entries()) {
    const v = res.verdicts!.find((x) => x.index === i)!;
    const at = `(${LETTER[i].toLowerCase()})`;
    if (v.ok === false) issues.push(`${at} ${v.issue || "ambiguë ou contraire au cours"}`);
    if (p.kind === "scq") {
      const a = String(v.answer ?? "").trim().toUpperCase();
      const k = /^[A-H]\b/.test(a) ? LETTER.indexOf(a[0]) : /^\d+$/.test(a) ? Number(a) : -1;
      if (k !== p.correct) issues.push(`${at} clé contestée : le juge choisit ${k >= 0 ? `« ${p.options[k] ?? a} »` : a || "rien"}`);
    } else if (p.kind === "code_output" && !p.codeChecked && !sameOutput(String(v.answer ?? ""), p.answer)) {
      issues.push(`${at} sortie du code contestée : le juge lit « ${String(v.answer ?? "").slice(0, 80)} »`);
    }
  }
  const off = said(res.off_course);
  if (off) issues.push(`hors cours : ${off}`);
  const mismatch = said(res.definition_mismatch);
  if (mismatch) issues.push(`définition différente du cours : ${mismatch}`);
  // Sortie du modèle non garantie : banc du 04/11 (CS-290 composite), « options » rendu en chaîne a
  // fait planter tout l'examen (« t.options.slice(...).join is not a function »).
  for (const t of Array.isArray(res.trivial_distractors) ? res.trivial_distractors : []) {
    const raw: unknown = t?.options;
    const opts = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" && raw.trim() ? [raw.trim()] : [];
    if (opts.length) issues.push(`(${LETTER[t.index]?.toLowerCase() ?? "?"}) distracteurs éliminables sans le cours : ${opts.slice(0, 3).join(" ; ")}`);
  }
  return issues;
}

/** Un bloc vérifié pour un emplacement : jusqu'à 3 versions, chacune corrigée des reproches de la précédente. */
/** Phase des blocs dans l'avancement : une unité par version d'un bloc (lib/progress). */
const BLOCKS_PHASE = "Questions composées";

/**
 * Les extraits du cours d'un emplacement : générateur et juge les lisent, le juge rejette « hors
 * cours » toute notion qu'ils ne définissent pas. Banc rs-composite du 22/11 (Q4, Q5, Q7 de CS-290
 * rejetées à chaque version) : une section d'annale énumère 4 ou 5 notions (« lecture de code
 * pandas, typologie mis/dis/mal-information, biais cognitifs… »), et une seule recherche par le nom
 * de la section ramenait l'en-tête de chaque support (la fenêtre se calait sur le premier mot
 * trouvé, le nom du chapitre), un support déjà cité n'en donnant plus d'autre : la théorie, plus
 * bas dans les mêmes supports, n'était jamais montrée. Une recherche par notion énumérée, puis
 * par notion du cours à mobiliser, chacune sur sa fenêtre la plus dense, plusieurs fenêtres
 * disjointes par support. Le nom de la section n'est plus cherché quand elle a d'autres termes.
 */
async function slotPassages(slot: BlockSlot): Promise<{ src: string; text: string }[]> {
  const rest = slot.query.filter((x) => x !== slot.section);
  const terms = rest.length ? rest : slot.query;
  const subjects = terms.flatMap((x) => x.split(/[,;](?![^(]*\))\s*/)).map((x) => x.trim()).filter((x) => x.length >= 3);
  return evidencePassages([...new Set([...subjects, ...slot.notions])], { perQuery: 2, cap: 900, budget: 9_000 }).catch(() => []);
}

async function buildBlock(slot: BlockSlot, i: number, n: number, plan: BlockPlan, ctx: BlockCtx, step: StepCb, work: PhaseProgress, firstGuidance: string | null = null): Promise<{ block: ExamBlock | null; why: string }> {
  const passages = await slotPassages(slot);
  let guidance: string | null = firstGuidance;
  let why = "";
  // Une version finie compte une unité ; en décider une de plus en AJOUTE une (le temps restant remonte alors).
  const retry = (attempt: number) => {
    work.done(BLOCKS_PHASE);
    if (attempt < ATTEMPTS) work.add(BLOCKS_PHASE);
  };
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    step(`Question composée ${i + 1}/${n}${attempt > 1 ? ` (version ${attempt})` : ""} : ${slot.section ?? slot.theme.slice(0, 60)}…`, 0);
    let b: ExamBlock;
    try {
      b = await generateBlock(slot, i, n, plan, ctx, guidance, passages);
    } catch (e) {
      why = llmFailureReason(e);
      // Quota, clé, plafond de dépense : inutile d'insister. Une réponse restée illisible : version suivante.
      const code = llmErrorCode(e);
      if (code && HARD_STOP_CODES.has(code)) {
        work.done(BLOCKS_PHASE);
        step(`Question composée ${i + 1} ignorée : ${why.slice(0, 140)}`, 0);
        return { block: null, why };
      }
      retry(attempt);
      step(`Question composée ${i + 1}, version ${attempt} inutilisable : ${why.slice(0, 140)}`, 0);
      continue;
    }
    const issues = [...await runCodeParts(b, plan.codeLanguage)];
    const judged = await judgeBlock(b, passages, plan.codeLanguage);
    if (judged) issues.push(...judged);
    if (!issues.length) {
      work.done(BLOCKS_PHASE);
      return { block: { ...b, verified: judged ? 1 : null }, why: "" };
    }
    why = issues.join(" ; ");
    retry(attempt);
    step(`Question composée ${i + 1} rejetée : ${why.slice(0, 220)}`, 0);
    guidance = why.slice(0, 1200);
  }
  return { block: null, why };
}

/**
 * NON-RECOUVREMENT (lib/block-overlap, sans appel au modèle) : une sous-question qui reprend le
 * sujet d'une autre question est retirée, si sa question garde assez de sous-questions ; sinon,
 * ou quand deux questions entières se recouvrent, la plus tardive est refaite une fois (seul cas
 * qui coûte), avec les sujets des autres à éviter. Refaite sans succès, elle reste telle quelle.
 * Les numéros des messages sont ceux de l'examen livré.
 */
/** Lettres de sous-questions citées dans un énoncé (« your answer to (c) », « partie b »), en indices. */
function lettersCited(prompt: string): number[] {
  return [...prompt.matchAll(/\(([a-h])\)|\b(?:part|partie|sous-question)\s+\(?([a-h])\)?(?!\p{L})/giu)].map((m) => (m[1] ?? m[2]).toLowerCase().charCodeAt(0) - 97);
}

async function separateBlocks(built: Map<number, ExamBlock>, slotAt: Map<number, BlockSlot>, n: number, plan: BlockPlan, ctx: BlockCtx, step: StepCb, work: PhaseProgress): Promise<void> {
  const order = [...built.keys()].sort((a, b) => a - b);
  const current = () => order.map((i) => built.get(i)!);
  const found = findOverlaps(current());
  const redo = new Map<number, Overlap>();
  for (const x of new Set(found.map((o) => o.block))) {
    const mine = found.filter((o) => o.block === x);
    const whole = mine.find((o) => o.part < 0);
    const b = built.get(order[x])!;
    const keep = b.parts.filter((_, k) => !mine.some((o) => o.part === k));
    // Les sous-questions restantes sont renumérotées : un renvoi à une lettre au-delà du premier
    // retrait (ou à la sous-question retirée) viserait la mauvaise. Alors on refait la question.
    const first = Math.min(...mine.map((o) => o.part));
    const shifted = keep.some((p) => lettersCited(p.prompt).some((k) => k >= first));
    if (whole || keep.length < plan.partsMin || shifted) {
      redo.set(x, whole ?? mine[0]);
      continue;
    }
    built.set(order[x], { ...b, parts: keep, points: keep.reduce((t, p) => t + p.points, 0) });
    for (const o of mine) step(`Question composée ${x + 1} : sous-question (${LETTER[o.part].toLowerCase()}) retirée, elle reprenait la question ${o.other + 1} (${o.terms.join(", ")})`, 0);
  }
  for (const [x, o] of redo) {
    const i = order[x];
    const other = built.get(order[o.other])!.title;
    work.add(BLOCKS_PHASE);
    step(`Question composée ${x + 1} refaite : elle reprenait la question ${o.other + 1} (${o.terms.join(", ")})`, 0);
    const others = order.filter((j) => j !== i).map((j) => built.get(j)!.title);
    const r = await buildBlock(slotAt.get(i)!, i, n, plan, { ...ctx, others }, step, work, `elle reprenait le sujet d'une autre question de l'examen (« ${other.slice(0, 120)} ») : prends un autre sujet de ce thème.`);
    const still = r.block ? findOverlaps(order.map((j) => (j === i ? r.block! : built.get(j)!))).some((v) => v.block === x || v.other === x) : true;
    if (r.block && !still) built.set(i, r.block);
    else step(`⚠ Question composée ${x + 1} gardée telle quelle : sa nouvelle version ${r.block ? "recouvre encore une autre question" : "n'a pas passé la vérification"}`, 0);
  }
}

/**
 * `total` réparti au prorata de `weights` en entiers (plus forts restes, à égalité l'ordre donné),
 * chacun au moins à son plancher ; somme exacte. null si les planchers dépassent déjà le total.
 */
function apportion(weights: number[], floors: number[], total: number): number[] | null {
  const spare = total - floors.reduce((s, f) => s + f, 0);
  if (spare < 0) return null;
  const sum = weights.reduce((s, w) => s + w, 0);
  // Au-delà des planchers, chacun reçoit sa part de ce qui reste au-dessus du plancher.
  const extra = weights.map((w, i) => Math.max(0, w * (total / (sum || 1)) - floors[i]));
  const scale = extra.reduce((s, e) => s + e, 0);
  const exact = extra.map((e) => (scale ? (e * spare) / scale : spare / weights.length));
  const out = exact.map((e, i) => floors[i] + Math.floor(e));
  const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0, rest = total - out.reduce((s, x) => s + x, 0); rest > 0; k = (k + 1) % out.length, rest--) out[order[k].i]++;
  return out;
}

/**
 * TOTAL DU FORMAT (22/11 : 6 questions sur 7 livrées, 42 pts au lieu des 50 de l'annale) : le total
 * lu dans l'annale est un contrat. Une question tombée, une sous-question retirée ou des points par
 * type qui ne tombent pas pile changent la somme ; on ramène alors les sous-questions au total, au
 * prorata de leurs points (entiers, au moins 1 point, critères d'une réponse courte compris), sans
 * appel au modèle : une question de secours de plus aurait déjà été tentée par les réserves.
 * Total non entier ou impossible à tenir (plus de sous-questions que de points) : rien ne change.
 */
export function fitToTotal(blocks: ExamBlock[], total: number | null): ExamBlock[] {
  const parts = blocks.flatMap((b) => b.parts);
  if (!total || !Number.isInteger(total) || !parts.length || parts.reduce((s, p) => s + p.points, 0) === total) return blocks;
  const pts = apportion(parts.map((p) => p.points), parts.map((p) => (p.kind === "short" ? Math.max(1, p.criteria.length) : 1)), total);
  if (!pts) return blocks;
  let k = 0;
  return blocks.map((b) => {
    const fitted = b.parts.map((p) => {
      const points = pts[k++];
      const crit = p.kind === "short" && p.criteria.length ? apportion(p.criteria.map((c) => c.points), p.criteria.map(() => 1), points) : null;
      return { ...p, points, ...(crit ? { criteria: p.criteria.map((c, j) => ({ ...c, points: crit[j] })) } : {}) };
    });
    return { ...b, parts: fitted, points: fitted.reduce((s, p) => s + p.points, 0) };
  });
}

/** Durées des phases sans historique (lib/jobs phaseHistory sinon), mêmes noms que les lignes « ⏱ ». */
const DEFAULT_PHASE_MS: Record<string, number> = { [BLOCKS_PHASE]: 8 * 60_000, PDF: 30_000 };

/**
 * Examen à questions composées : un bloc par emplacement (section de l'annale modèle ou
 * chapitre), construits en parallèle borné ; un emplacement qui échoue 3 fois passe à une
 * notion de réserve. Livré avec ce qui a passé : le manque est dit, et compté par l'appelant
 * (remboursement au prorata, lib/jobs settleShortfall).
 */
export async function generateBlockExam(
  plan: BlockPlan,
  opts: { focus?: string; onStep?: StepCb; onExamReady?: (examId: number) => void | Promise<void>; phaseMs?: Record<string, number> } = {},
): Promise<{ id: number; count: number; requested: number; texError?: string; texWarning?: string }> {
  const report = opts.onStep ?? (() => {});
  const tStart = Date.now();
  const n = plan.blockCount;
  // TEMPS RESTANT — avancement PAR PHASE (lib/progress) : les blocs construits en parallèle
  // publiaient chacun leur pourcentage (10 + 70·i/n au départ de chacun) ; il reculait.
  const phaseMs = { ...DEFAULT_PHASE_MS, ...(opts.phaseMs ?? {}) };
  const work = new PhaseProgress(8, [[{ name: BLOCKS_PHASE, units: n, ms: phaseMs[BLOCKS_PHASE] }], [{ name: "PDF", units: 1, ms: phaseMs.PDF }]]);
  const step: StepCb = (m) => report(m, work.pct());
  const { slots, spares } = await planSlots(plan);
  if (!slots.length) throw new Error("Aucune notion ni section du cours à couvrir : prépare le cours avant de générer.");
  const { counterExamplesBlock } = await import("@/lib/question-reports");
  const ctx = { system: blockSystemPrompt(plan, n, await counterExamplesBlock().catch(() => "")), previous: await recentBlockPrompts(), focus: opts.focus };
  step(`Architecte : ${n} questions composées (scénario + ${plan.partsMin} à ${plan.partsMax} sous-questions)${plan.sections.length ? `, une par section de l'annale modèle` : ""}…`, 8);

  const built = new Map<number, ExamBlock>();
  const failed: { i: number; why: string }[] = [];
  const tBlocks = Date.now();
  const slotAt = new Map<number, BlockSlot>();
  const subjectOf = (s: BlockSlot) => (s.notions.length ? `${s.theme} (notions : ${s.notions.slice(0, 2).join(", ")})` : s.theme);
  const othersOf = (i: number) => slots.filter((_, j) => j !== i).map(subjectOf);
  await runPool(slots.map((s, i) => ({ s, i })), blockConcurrency(), async ({ s, i }) => {
    const r = await buildBlock(s, i, n, plan, { ...ctx, others: othersOf(i) }, step, work);
    if (r.block) {
      built.set(i, r.block);
      slotAt.set(i, s);
    }
    else failed.push({ i, why: r.why });
  });
  // Réserves, une à une jusqu'à un bloc qui passe : d'abord celles de la même section (annale
  // modèle : seulement elles, une section ne se remplace pas par une autre), sinon une autre notion.
  for (const f of failed.sort((a, b) => a.i - b.i)) {
    const section = slots[f.i].section;
    for (;;) {
      const k = spares.findIndex((s) => s.section === section);
      const at = k >= 0 ? k : plan.sections.length ? -1 : 0;
      if (at < 0 || !spares.length) break;
      const [spare] = spares.splice(at, 1);
      work.add(BLOCKS_PHASE); // une reprise : réessai ajouté
      step(`Question composée ${f.i + 1} : reprise sur ${spare.theme.slice(0, 80)}…`, 0);
      const r = await buildBlock(spare, f.i, n, plan, { ...ctx, others: othersOf(f.i) }, step, work);
      if (r.block) {
        built.set(f.i, r.block);
        slotAt.set(f.i, spare);
        break;
      }
    }
  }
  await separateBlocks(built, slotAt, n, plan, ctx, step, work);
  const blocks = fitToTotal([...built.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b), plan.totalPoints);
  if (!blocks.length) throw new Error(`Aucune question composée n'a passé la vérification${failed[0]?.why ? ` (${failed[0].why.slice(0, 200)})` : ""}.`);
  if (blocks.length < n) step(`⚠ ${blocks.length}/${n} questions composées livrées : ${n - blocks.length} rejetée(s) après ${ATTEMPTS} versions.`, 0);
  step(phaseLine(BLOCKS_PHASE, Date.now() - tBlocks), 0);

  const missing = failed.filter((f) => !built.has(f.i)).sort((a, b) => a.i - b.i).map((f) => slots[f.i].section ?? slots[f.i].theme.slice(0, 80));
  const examId = await saveBlockExam(blocks, { requested: n, missing });
  await opts.onExamReady?.(examId);
  step("Rendu du PDF (énoncé + corrigé)…", 0);
  const tPdf = Date.now();
  const { buildBlocksArtifact } = await import("@/lib/blocks-latex");
  const art = await buildBlocksArtifact(examId, blocks, nowStr().slice(0, 10)).catch((e: Error) => ({ file: "", texError: e.message, texWarning: undefined as string | undefined }));
  work.done("PDF");
  if (art.texError) step(`⚠ PDF non compilé (${art.texError.slice(0, 160)}), l'examen reste consultable en ligne`, 0);
  else if (art.texWarning) step(`⚠ ${art.texWarning.slice(0, 200)}`, 0);
  step(phaseLine("PDF", Date.now() - tPdf), 0);
  step(phaseLine("Total", Date.now() - tStart), 0);
  const verified = blocks.filter((b) => b.verified === 1).length;
  await q.run(`UPDATE exams SET status = 'ready', html_path = ?, verify_summary = ? WHERE id = ?`, art.file || null, blocksSummary(blocks.length, n, verified), examId);
  report(`Examen #${examId} prêt : ${blocks.length} questions composées ✓`, 100);
  return { id: examId, count: blocks.length, requested: n, ...(art.texError ? { texError: art.texError } : {}), ...(art.texWarning ? { texWarning: art.texWarning } : {}) };
}

/** « 4/4 questions composées vérifiées à l'aveugle », ou, quand une question manque, « 4 questions composées sur 5 demandées, … ». */
export function blocksSummary(count: number, requested: number, verified: number): string {
  const qs = (n: number) => `${n} question${n > 1 ? "s" : ""} composée${n > 1 ? "s" : ""}`;
  if (count >= requested) return `${verified}/${count} questions composées vérifiées à l'aveugle`;
  return `${qs(count)} sur ${requested} demandées, ${verified} vérifiée${verified > 1 ? "s" : ""} à l'aveugle`;
}

/** Le corrigé PDF d'un examen, s'il a compilé. */
export async function solutionsPdf(htmlPath: string | null): Promise<string | null> {
  const file = htmlPath && htmlPath.endsWith(".pdf") ? htmlPath.replace(/\.pdf$/, "-corrige.pdf") : "";
  return file && (await storage().stat(path.join(examsDir(), path.basename(file)))) ? file : null;
}

async function ensureBlockSchema(): Promise<void> {
  await q.ensureTable("exams");
  await q.ensureColumns("exams", ["verify_summary", "requested_count", "missing_json"]);
  await q.ensureTable("exam_blocks");
  await q.ensureTable("block_parts");
}

/** `requested` et `missing` (sections tombées) : le manque est dit sur l'examen, pas seulement à la fin du job. */
export async function saveBlockExam(blocks: ExamBlock[], ask: { requested: number; missing: string[] } = { requested: blocks.length, missing: [] }): Promise<number> {
  await ensureBlockSchema();
  const examId = await q.insert(`INSERT INTO exams (format_template, status, requested_count, missing_json) VALUES ('blocks','generating',?,?)`, ask.requested, JSON.stringify(ask.missing));
  for (const [i, b] of blocks.entries()) {
    const blockId = await q.insert(`INSERT INTO exam_blocks (exam_id, idx, title, section, scenario, points, verified) VALUES (?,?,?,?,?,?,?)`, examId, i, b.title, b.section, b.scenario, b.points, b.verified);
    for (const [k, p] of b.parts.entries()) {
      await q.run(
        `INSERT INTO block_parts (block_id, exam_id, idx, kind, prompt, code, options_json, correct, answer, criteria_json, points, explanation, code_checked) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        blockId, examId, k, p.kind, p.prompt, p.code || null, JSON.stringify(p.options), p.correct, p.answer, JSON.stringify(p.criteria), p.points, p.explanation, p.codeChecked ? 1 : 0,
      );
    }
  }
  return examId;
}

// ───────────────────────────── lecture, correction ─────────────────────────────

export type PartView = { id: number; idx: number; kind: PartKind; prompt: string; code: string; options: string[]; points: number; correct?: number; answer?: string; criteria?: Criterion[]; explanation?: string };
export type BlockView = { id: number; idx: number; title: string; section: string | null; scenario: string; points: number; parts: PartView[] };
/** `solutions` : le PDF du corrigé, seulement s'il existe (il peut ne pas avoir compilé). */
/** `requested` : questions demandées (≥ blocks.length) ; `missing` : sections de l'annale tombées à la vérification. */
export type BlockExamView = { kind: "blocks"; id: number; createdAt: string; status: string; verifySummary: string | null; pdf: string | null; solutions: string | null; requested: number; missing: string[]; blocks: BlockView[] };

function parseMissing(raw: string | null): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

type PartRow = { id: number; block_id: number; idx: number; kind: PartKind; prompt: string; code: string | null; options_json: string | null; correct: number | null; answer: string | null; criteria_json: string | null; points: number; explanation: string | null };

/** L'examen à questions composées ; sans `withKeys`, ni réponse, ni barème, ni explication. null s'il n'existe pas. */
export async function getBlockExam(examId: number, withKeys = false): Promise<BlockExamView | null> {
  await ensureBlockSchema();
  const e = await q.get<{ id: number; created_at: string; status: string | null; verify_summary: string | null; html_path: string | null; requested_count: number | null; missing_json: string | null }>(
    `SELECT id, created_at, status, verify_summary, html_path, requested_count, missing_json FROM exams WHERE id = ? AND format_template = 'blocks'`, examId,
  );
  if (!e) return null;
  const blocks = await q.all<{ id: number; idx: number; title: string; section: string | null; scenario: string; points: number }>(`SELECT id, idx, title, section, scenario, points FROM exam_blocks WHERE exam_id = ? ORDER BY idx`, examId);
  const parts = await q.all<PartRow>(`SELECT * FROM block_parts WHERE exam_id = ? ORDER BY block_id, idx`, examId);
  return {
    kind: "blocks", id: e.id, createdAt: e.created_at, status: e.status ?? "ready", verifySummary: examSummaryLabel(e.verify_summary), pdf: e.html_path ?? null, solutions: await solutionsPdf(e.html_path),
    // Examens d'avant la colonne : rien n'est dit (le nombre demandé n'a pas été gardé).
    requested: Math.max(blocks.length, Number(e.requested_count ?? 0)), missing: parseMissing(e.missing_json),
    blocks: blocks.map((b) => ({
      id: b.id, idx: b.idx, title: b.title, section: b.section, scenario: b.scenario, points: Number(b.points),
      parts: parts.filter((p) => p.block_id === b.id).map((p) => ({
        id: p.id, idx: p.idx, kind: p.kind, prompt: p.prompt, code: p.code ?? "", options: JSON.parse(p.options_json ?? "[]"), points: Number(p.points),
        ...(withKeys ? { correct: Number(p.correct ?? -1), answer: p.answer ?? "", criteria: JSON.parse(p.criteria_json ?? "[]"), explanation: p.explanation ?? "" } : {}),
      })),
    })),
  };
}

export type PartGrade = { partId: number; kind: PartKind; ok: boolean | null; points: number; max: number; correct: number; answer: string; criteria: Criterion[]; explanation: string };

/**
 * Correction : choix unique et lecture de code automatiques (sortie comparée sans les espaces
 * de fin) ; une réponse courte n'est pas notée ici (ok = null) — elle se corrige critère par
 * critère (lib/check-solution, barème de la question), et son barème est révélé.
 */
export async function gradeBlocks(examId: number, answers: Record<string, unknown>): Promise<{ kind: "blocks"; score: number; total: number; pending: number; detail: PartGrade[] } | null> {
  const exam = await getBlockExam(examId, true);
  if (!exam) return null;
  const detail: PartGrade[] = [];
  for (const p of exam.blocks.flatMap((b) => b.parts)) {
    const given = answers[String(p.id)];
    const ok = p.kind === "scq" ? Number(given) === p.correct : p.kind === "code_output" ? typeof given === "string" && sameOutput(given, p.answer ?? "") : null;
    detail.push({ partId: p.id, kind: p.kind, ok, points: ok ? p.points : 0, max: p.points, correct: p.correct ?? -1, answer: p.answer ?? "", criteria: p.criteria ?? [], explanation: p.explanation ?? "" });
  }
  const auto = detail.filter((d) => d.ok !== null);
  return {
    kind: "blocks",
    score: auto.reduce((s, d) => s + d.points, 0),
    total: auto.reduce((s, d) => s + d.max, 0),
    pending: detail.filter((d) => d.ok === null).reduce((s, d) => s + d.max, 0),
    detail,
  };
}

/** Une réponse courte à corriger : l'énoncé complet (scénario + sous-question), son barème et la réponse modèle. */
export async function shortPartForCheck(examId: number, partId: number): Promise<{ statement: string; rubric: Criterion[]; reference: string } | null> {
  await ensureBlockSchema();
  const r = await q.get<{ scenario: string; prompt: string; kind: string; answer: string | null; criteria_json: string | null }>(
    `SELECT b.scenario, p.prompt, p.kind, p.answer, p.criteria_json FROM block_parts p JOIN exam_blocks b ON b.id = p.block_id WHERE p.id = ? AND p.exam_id = ?`, partId, examId,
  );
  if (!r || r.kind !== "short") return null;
  const rubric = JSON.parse(r.criteria_json ?? "[]") as Criterion[];
  return rubric.length ? { statement: `${r.scenario}\n\n${r.prompt}`, rubric, reference: r.answer ?? "" } : null;
}

/** Recompile le PDF d'un examen à questions composées depuis la base, sans le modèle. null si ce n'en est pas un. */
export async function recompileBlocksPdf(examId: number): Promise<{ file: string; texError?: string; texWarning?: string } | null> {
  const exam = await getBlockExam(examId, true);
  if (!exam) return null;
  const blocks: ExamBlock[] = exam.blocks.map((b) => ({
    title: b.title, section: b.section, scenario: b.scenario, points: b.points, verified: null,
    parts: b.parts.map((p) => ({ kind: p.kind, prompt: p.prompt, code: p.code, options: p.options, correct: p.correct ?? -1, answer: p.answer ?? "", criteria: p.criteria ?? [], points: p.points, explanation: p.explanation ?? "" })),
  }));
  const { buildBlocksArtifact } = await import("@/lib/blocks-latex");
  const art = await buildBlocksArtifact(examId, blocks, exam.createdAt.slice(0, 10));
  if (art.file) await q.run(`UPDATE exams SET html_path = ? WHERE id = ?`, art.file, examId);
  return art;
}
