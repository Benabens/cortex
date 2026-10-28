import { q } from "@/db/q";
import { completeText, extractJson } from "@/lib/llm";
import { courseRefImages } from "@/lib/course-vision";
import { DATA_RULE, dataBlock } from "@/lib/prompt-safety";
import { EXAM_KINDS, type ExamKind, type StoredProfile } from "@/lib/exam-format";

/**
 * DÉTECTION DE FORMAT (générique, par matière). Le moteur ne hardcode RIEN : il LIT le
 * format des examens passés ingérés (structure, types de questions, proportions, barème, et la
 * convention « une seule bonne réponse (SCQ) » vs « une ou plusieurs (MCQ) » telle qu'écrite dans
 * les énoncés) et le reproduit. Stocké par cours dans `format_profile` (lazy).
 *
 *  - ML / Analyse : gros bloc de QCM (≈25) + partie ouverte.
 *  - CS-202 : calcul / trace / figures (son format historique — non détecté, intact).
 */

export type QuestionType = "scq" | "mcq" | "open" | "calc" | "proof" | "other";
export type FormatProfile = {
  format_summary: string;
  duration_min: number;
  total_points: number;
  has_mcq: boolean; // au moins un bloc de QCM → bascule sur le générateur QCM
  scq_vs_mcq_convention: string; // comment l'énoncé distingue « une seule » vs « plusieurs »
  question_types: { type: QuestionType; approx_count: number; share_pct: number; points_each: number; note: string }[];
  sections: { name: string; description: string }[];
  topics_emphasis: { topic: string; share_pct: number }[];
};

const FORMAT_SCHEMA = {
  type: "object",
  properties: {
    format_summary: { type: "string", description: "Une phrase : la structure d'un examen type de ce cours (ex. « ~25 QCM à une seule réponse + 1 partie ouverte de dérivation »)." },
    duration_min: { type: "integer" },
    total_points: { type: "integer" },
    has_mcq: { type: "boolean", description: "true si l'examen comporte un bloc de QCM (choix multiples)." },
    scq_vs_mcq_convention: { type: "string", description: "Comment l'énoncé indique « exactement une bonne réponse » (SCQ) vs « une ou plusieurs » (MCQ) — cite la formulation réelle si visible." },
    question_types: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", description: "scq | mcq | open | calc | proof | other" },
          approx_count: { type: "integer", description: "Nombre approximatif de ce type dans un examen." },
          share_pct: { type: "number", description: "Part en % des points (somme ≈ 100)." },
          points_each: { type: "number" },
          note: { type: "string" },
        },
        required: ["type", "approx_count", "share_pct"],
        additionalProperties: false,
      },
    },
    sections: { type: "array", items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } }, required: ["name"], additionalProperties: false } },
    topics_emphasis: { type: "array", items: { type: "object", properties: { topic: { type: "string" }, share_pct: { type: "number" } }, required: ["topic"], additionalProperties: false } },
  },
  required: ["format_summary", "has_mcq", "question_types"],
  additionalProperties: false,
} as const;

async function ensureFormatSchema(): Promise<void> {
  await q.ensureTable("format_profile");
}

/** Texte des examens de référence du cours (récents pondérés plus fort). */
async function gatherExamsText(cap = 18000): Promise<string> {
  const rows = await q.all<{ title: string; year: number | null; text: string }>(
    `SELECT s.title, s.year, i.text FROM items i JOIN sources s ON s.id = i.source_id
       WHERE s.type IN ('final','midterm') ORDER BY (s.year IS NULL), s.year DESC, s.id`
  );
  let out = "";
  for (const r of rows) {
    const chunk = `\n— (${r.title}${r.year ? `, ${r.year}` : ""}) —\n${r.text}\n`;
    if (out.length + chunk.length > cap) { out += chunk.slice(0, cap - out.length); break; }
    out += chunk;
  }
  return out.trim();
}

/**
 * Détecte le format d'examen du cours courant et le persiste : depuis les
 * annales (LLM + vision) quand il y en a ; sinon depuis les questions d'exemple
 * officielles, les consignes d'examen ou les indices du corpus, preuves citées
 * (cf. detectWithoutAnnales). Ne lève plus d'erreur faute d'annales : un cours
 * sans annale se prépare quand même, son format restant au besoin « inconnu ».
 */
export async function detectFormat(opts: { onStep?: (m: string, p: number) => void } = {}): Promise<FormatProfile> {
  await ensureFormatSchema();
  const step = opts.onStep ?? (() => {});
  step("Lecture des examens passés du cours…", 10);
  const text = await gatherExamsText();
  if (!text) return detectWithoutAnnales(step);
  const imgs = courseRefImages().slice(0, 8);
  step("Détection du format (types · proportions · barème · SCQ/MCQ) via le LLM…", 40);
  const prompt = [
    `Tu analyses le FORMAT des examens de ce cours pour pouvoir en générer de NOUVEAUX au même format. Ne hardcode rien : DÉDUIS tout des énoncés réels ci-dessous.`,
    imgs.length ? `Pages d'examens réelles (outil Read — observe la mise en page, les blocs de QCM, le barème) :\n${imgs.map((p) => `  - ${p}`).join("\n")}` : ``,
    ``,
    DATA_RULE,
    ``,
    dataBlock(`TEXTE DES EXAMENS PASSÉS (vérité terrain)`, [{ src: "annales", text }]),
    ``,
    `═══ TA TÂCHE ═══`,
    `Décris le format d'UN examen type : structure (sections), TYPES de questions (scq = QCM à UNE seule réponse / mcq = QCM à PLUSIEURS réponses possibles / open / calc / proof), leur NOMBRE et leur PART en % des points, le BARÈME, la DURÉE, le total de points, et surtout la CONVENTION écrite qui distingue « exactement une bonne réponse » de « une ou plusieurs » (cite la formulation réelle). has_mcq=true s'il y a un bloc de QCM. Ajoute l'emphase par thème si visible.`,
    `Réponds UNIQUEMENT avec l'objet JSON conforme. Aucun fichier écrit.`,
    JSON.stringify(FORMAT_SCHEMA, null, 2),
  ].filter(Boolean).join("\n");
  const profile = extractJson<FormatProfile>(await completeText({ prompt, model: "opus", timeoutMs: 300_000 }));
  step("Enregistrement du profil de format…", 90);
  await saveProfile({ ...profile, basis: "annales" });
  step("Format détecté ✓", 100);
  return profile;
}

async function saveProfile(p: StoredProfile): Promise<void> {
  await q.run(`DELETE FROM format_profile`);
  await q.run(`INSERT INTO format_profile (json) VALUES (?)`, JSON.stringify(p));
}

// ─────────────────────────── sans annale ───────────────────────────

type Passage = { src: string; text: string };
export type FormatEvidence = { basis: "sample_questions" | "course_info"; passages: Passage[] };

/** Indices qui suffisent seuls : ils décrivent la forme d'une question d'examen. */
const STRONG_CUE = /\b(?:QCM|MCQ|SCQ)\b|multiple[- ]choice|choix multiples?|single[- ]choice|une seule (?:bonne )?r[ée]ponse|only one (?:correct )?answer/gi;
/** Mots d'examen, et indices qui n'en sont qu'à côté d'eux (« essai », « 45 minutes », « 30 % »). */
const EXAM_WORD = /\b(?:examens?|exams?|midterms?|mi-semestre|partiels?|[ée]valuations?|quiz|[ée]preuves?)\b/gi;
const WEAK_CUE = /\b(?:essai|dissertation|oral|dur[ée]e|minutes|questions? ouvertes?|open questions?|essay)\b|\d{1,3}\s?%/i;

const PASSAGES_MAX = 10;
const PASSAGES_CHARS = 9000;

async function textsOfType(type: string, cap: number): Promise<Passage[]> {
  const rows = await q.all<{ src: string; text: string }>(
    `SELECT s.title src, i.text text FROM items i JOIN sources s ON s.id = i.source_id WHERE s.type = ? ORDER BY s.id, i.id`, type,
  );
  const out: Passage[] = [];
  let used = 0;
  for (const r of rows) {
    if (used >= cap) break;
    const t = r.text.slice(0, cap - used);
    out.push({ src: r.src, text: t });
    used += t.length;
  }
  return out;
}

/** Fenêtres de texte autour des indices de format, fusionnées par item. */
export function formatCueWindows(text: string, radius = 350): string[] {
  const spans: [number, number][] = [];
  for (const m of text.matchAll(STRONG_CUE)) spans.push([Math.max(0, m.index! - radius), m.index! + m[0].length + radius]);
  for (const m of text.matchAll(EXAM_WORD)) {
    const lo = Math.max(0, m.index! - radius), hi = m.index! + m[0].length + radius;
    if (WEAK_CUE.test(text.slice(lo, hi))) spans.push([lo, hi]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  return merged.map(([lo, hi]) => text.slice(lo, hi).trim());
}

/**
 * Ce que les sources disent du format quand il n'y a pas d'annale, du plus sûr
 * au moins sûr : questions d'exemple officielles, consignes d'examen, indices
 * dans le reste du corpus. null : rien ne parle du format.
 */
export async function gatherFormatEvidence(): Promise<FormatEvidence | null> {
  const samples = await textsOfType("sample_questions", PASSAGES_CHARS);
  if (samples.length) return { basis: "sample_questions", passages: samples };
  const info = await textsOfType("exam_info", PASSAGES_CHARS);
  if (info.length) return { basis: "course_info", passages: info };
  const rows = await q.all<{ src: string; text: string }>(
    `SELECT s.title src, i.text text FROM items i JOIN sources s ON s.id = i.source_id ORDER BY s.recency_weight DESC, s.id, i.id LIMIT 4000`,
  );
  const out: Passage[] = [];
  let used = 0;
  for (const r of rows) {
    for (const w of formatCueWindows(r.text)) {
      if (out.length >= PASSAGES_MAX || used >= PASSAGES_CHARS) break;
      out.push({ src: r.src, text: w });
      used += w.length;
    }
  }
  return out.length ? { basis: "course_info", passages: out } : null;
}

const NO_ANNALES_SCHEMA = {
  type: "object",
  properties: {
    exam_kind: { type: ["string", "null"], description: "qcm | exercises | mixed | essay | oral — ou null si les passages ne disent PAS la forme de l'examen." },
    question_count: { type: ["integer", "null"], description: "Nombre de questions de l'examen s'il est écrit, sinon null." },
    open_count: { type: ["integer", "null"], description: "Questions ouvertes d'un examen mixte si c'est écrit, sinon null." },
    duration_min: { type: ["integer", "null"], description: "Durée en minutes si elle est écrite, sinon null." },
    format_summary: { type: "string", description: "Une phrase : ce que les passages disent de l'examen." },
    evidence: { type: "array", items: { type: "string" }, description: "Citations EXACTES (copiées mot pour mot, ≤ 200 caractères chacune) des passages qui justifient exam_kind." },
    examples: { type: "array", items: { type: "string" }, description: "Questions d'exemple officielles présentes dans les passages, recopiées MOT POUR MOT avec leurs options (au plus 4). Vide s'il n'y en a pas." },
  },
  required: ["exam_kind", "format_summary", "evidence", "examples"],
  additionalProperties: false,
} as const;

const norm = (s: string) => s.toLowerCase().normalize("NFC").replace(/[’‘`´]/g, "'").replace(/[«»“”]/g, "\"").replace(/\s+/g, " ").trim();

/** Garde les citations retrouvées telles quelles dans les passages (au moins 12 caractères). */
export function verifiedQuotes(quotes: unknown, passages: Passage[], maxLen = 600): string[] {
  if (!Array.isArray(quotes)) return [];
  const hay = norm(passages.map((p) => p.text).join(" \n "));
  return quotes
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().slice(0, maxLen))
    .filter((x) => norm(x).length >= 12 && hay.includes(norm(x)));
}

const intOrNull = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);

async function detectWithoutAnnales(step: (m: string, p: number) => void): Promise<StoredProfile> {
  const unknown: StoredProfile = {
    basis: "unknown", exam_kind: null, format_summary: "", duration_min: 0, total_points: 0, has_mcq: false,
    scq_vs_mcq_convention: "", question_types: [], sections: [], topics_emphasis: [], evidence: [], examples: [],
  };
  step("Pas d'annale : recherche du format dans les sources (exemples officiels, consignes, indices)…", 30);
  const ev = await gatherFormatEvidence();
  if (!ev) {
    await saveProfile(unknown);
    step("Aucune annale ni indication de format dans les sources : format inconnu, à déclarer.", 100);
    return unknown;
  }
  const prompt = [
    `Tu lis des extraits des sources d'un cours qui n'a PAS d'annale, pour savoir quelle FORME a son examen. Ne devine rien : ne réponds que ce que les extraits DISENT.`,
    ev.basis === "sample_questions"
      ? `Ces extraits sont des questions d'exemple OFFICIELLES de l'enseignant (le style de l'examen).`
      : `Ces extraits sont des passages du cours qui parlent de l'examen ou de questions d'examen (consignes, slides, syllabus).`,
    ``,
    DATA_RULE,
    ``,
    dataBlock(`EXTRAITS DES SOURCES DU COURS`, ev.passages),
    ``,
    `═══ TA TÂCHE ═══`,
    `exam_kind : qcm (questions à choix), exercises (problèmes à résoudre), mixed (QCM + questions ouvertes), essay (essai / dissertation argumentée), oral — ou null si les extraits ne le disent pas.`,
    `evidence : recopie MOT POUR MOT les phrases des extraits qui le justifient (elles seront vérifiées ; une citation introuvable annule la détection).`,
    `examples : recopie mot pour mot les questions d'exemple présentes (énoncé + options), sinon [].`,
    `Réponds UNIQUEMENT avec l'objet JSON conforme.`,
    JSON.stringify(NO_ANNALES_SCHEMA, null, 2),
  ].join("\n");
  step("Lecture des indices de format (LLM, preuves citées)…", 50);
  let raw: Record<string, unknown>;
  try {
    raw = extractJson<Record<string, unknown>>(await completeText({ prompt, model: "opus", timeoutMs: 300_000, json: { schema: NO_ANNALES_SCHEMA as unknown as object } }));
  } catch (e) {
    await saveProfile(unknown);
    step(`Lecture des indices de format impossible (${(e as Error).message.slice(0, 60)}) : format inconnu, à déclarer.`, 100);
    return unknown;
  }
  const kind = (EXAM_KINDS as readonly string[]).includes(String(raw.exam_kind)) ? (raw.exam_kind as ExamKind) : null;
  const evidence = verifiedQuotes(raw.evidence, ev.passages, 200);
  if (!kind || !evidence.length) {
    await saveProfile(unknown);
    step("Les sources ne disent pas clairement la forme de l'examen : format inconnu, à déclarer.", 100);
    return unknown;
  }
  const questionCount = intOrNull(raw.question_count, 1, 200);
  const openCount = intOrNull(raw.open_count, 0, 50);
  const isQcm = kind === "qcm" || kind === "mixed";
  const profile: StoredProfile = {
    basis: ev.basis,
    exam_kind: kind,
    question_count: questionCount,
    open_count: openCount,
    format_summary: typeof raw.format_summary === "string" ? raw.format_summary.slice(0, 300) : "",
    duration_min: intOrNull(raw.duration_min, 5, 600) ?? 0,
    total_points: 0,
    has_mcq: isQcm,
    scq_vs_mcq_convention: "",
    question_types: isQcm ? [{ type: "scq", approx_count: questionCount ?? 0, share_pct: kind === "qcm" ? 100 : 60, points_each: 1, note: "" }] : [],
    sections: [],
    topics_emphasis: [],
    evidence,
    examples: verifiedQuotes(raw.examples, ev.passages, 600).slice(0, 4),
  };
  await saveProfile(profile);
  step(`Format déduit des ${ev.basis === "sample_questions" ? "questions d'exemple officielles" : "infos du cours"} ✓`, 100);
  return profile;
}

/** Profil de format du cours courant (null si pas encore détecté). */
export async function getFormatProfile(): Promise<FormatProfile | null> {
  await ensureFormatSchema();
  const r = await q.get<{ json: string }>(`SELECT json FROM format_profile ORDER BY id DESC LIMIT 1`);
  if (!r) return null;
  try { return JSON.parse(r.json) as FormatProfile; } catch { return null; }
}
