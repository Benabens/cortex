import { completeText, extractJson } from "@/lib/llm";
import { profile } from "@/lib/course-profile";

export type Drill = {
  concept: string;
  statement_html: string;
  hints: string[]; // 5, du plus vague au plus précis
  solution_html: string;
};

const DRILL_SCHEMA = {
  type: "object",
  properties: {
    concept: { type: "string" },
    statement_html: { type: "string", description: "Énoncé en HTML simple (p, ul, li, code, pre, table)." },
    hints: { type: "array", items: { type: "string" }, description: "EXACTEMENT 5 indices, du plus vague (nommer la technique) au plus précis (quasi la solution)." },
    solution_html: { type: "string", description: "Corrigé détaillé en HTML simple." },
  },
  required: ["concept", "statement_html", "hints", "solution_html"],
  additionalProperties: false,
} as const;

/** Génère UNE question ciblée façon examen CS-202 + 5 indices progressifs (via Max). */
export async function generateDrill(concept: string): Promise<Drill> {
  const p = profile();
  const prompt = [
    p.qaIntro(),
    p.directivesBlock(),
    ``,
    `Génère UNE seule question d'entraînement ciblée sur : « ${concept} ».`,
    `Elle doit être APPLIQUÉE (calculer / tracer / remplir / justifier), au format et niveau d'un vrai final EPFL, en respectant les CONTRAINTES DURES ci-dessus.`,
    `Fournis aussi une ÉCHELLE DE 5 INDICES, du plus vague (juste nommer la technique/le concept à utiliser) au plus précis (presque la solution complète, étape par étape) — ils seront révélés un par un.`,
    `statement_html et solution_html en HTML SIMPLE (<p>,<ul>,<li>,<code>,<pre>,<table>,<strong>). Pas d'images, pas de LaTeX.`,
    `Réponds UNIQUEMENT avec l'objet JSON conforme au schéma. Aucun outil, aucun fichier.`,
    JSON.stringify(DRILL_SCHEMA, null, 2),
  ].join("\n");
  const text = await completeText({ prompt, model: "opus", timeoutMs: 220_000 });
  const d = extractJson<Drill>(text);
  if (!Array.isArray(d.hints)) d.hints = [];
  d.hints = d.hints.slice(0, 5);
  return d;
}
