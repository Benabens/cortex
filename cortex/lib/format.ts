import { currentCourse } from "@/db/client";
import { q } from "@/db/q";
import { completeText, extractJson } from "@/lib/llm";
import { courseRefImages } from "@/lib/course-vision";

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

/** Détecte le format d'examen du cours courant (LLM + vision sur les annales) et le persiste. */
export async function detectFormat(opts: { onStep?: (m: string, p: number) => void } = {}): Promise<FormatProfile> {
  await ensureFormatSchema();
  const step = opts.onStep ?? (() => {});
  step("Lecture des examens passés du cours…", 10);
  const text = await gatherExamsText();
  if (!text) throw new Error("Aucun examen de référence ingéré pour ce cours — dépose des annales dans data/<cours>/refs/.");
  const imgs = courseRefImages().slice(0, 8);
  step("Détection du format (types · proportions · barème · SCQ/MCQ) via le LLM…", 40);
  const prompt = [
    `Tu analyses le FORMAT des examens de ce cours pour pouvoir en générer de NOUVEAUX au même format. Ne hardcode rien : DÉDUIS tout des énoncés réels ci-dessous.`,
    imgs.length ? `Pages d'examens réelles (outil Read — observe la mise en page, les blocs de QCM, le barème) :\n${imgs.map((p) => `  - ${p}`).join("\n")}` : ``,
    ``,
    `═══ TEXTE DES EXAMENS PASSÉS (vérité terrain) ═══`,
    text,
    ``,
    `═══ TA TÂCHE ═══`,
    `Décris le format d'UN examen type : structure (sections), TYPES de questions (scq = QCM à UNE seule réponse / mcq = QCM à PLUSIEURS réponses possibles / open / calc / proof), leur NOMBRE et leur PART en % des points, le BARÈME, la DURÉE, le total de points, et surtout la CONVENTION écrite qui distingue « exactement une bonne réponse » de « une ou plusieurs » (cite la formulation réelle). has_mcq=true s'il y a un bloc de QCM. Ajoute l'emphase par thème si visible.`,
    `Réponds UNIQUEMENT avec l'objet JSON conforme. Aucun fichier écrit.`,
    JSON.stringify(FORMAT_SCHEMA, null, 2),
  ].filter(Boolean).join("\n");
  const profile = extractJson<FormatProfile>(await completeText({ prompt, model: "opus", timeoutMs: 300_000 }));
  step("Enregistrement du profil de format…", 90);
  await q.run(`DELETE FROM format_profile`);
  await q.run(`INSERT INTO format_profile (json) VALUES (?)`, JSON.stringify(profile));
  step("Format détecté ✓", 100);
  return profile;
}

/** Profil de format du cours courant (null si pas encore détecté). */
export async function getFormatProfile(): Promise<FormatProfile | null> {
  await ensureFormatSchema();
  const r = await q.get<{ json: string }>(`SELECT json FROM format_profile ORDER BY id DESC LIMIT 1`);
  if (!r) return null;
  try { return JSON.parse(r.json) as FormatProfile; } catch { return null; }
}

/** true si le cours s'examine principalement en QCM (→ générateur QCM). */
export async function isQcmCourse(): Promise<boolean> {
  if (currentCourse() === "cs-202") return false; // CS-202 garde son format calcul/trace
  const p = await getFormatProfile();
  return !!p?.has_mcq;
}
