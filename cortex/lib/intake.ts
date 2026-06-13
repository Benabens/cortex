import { extractJson, runClaudeCode } from "@/lib/claude-code";

/**
 * V5 — Détection du TYPE d'entrée texte de l'exo ciblé (au-delà de l'image).
 * Le champ « sujet » accepte désormais du gros texte ; on classe par le modèle :
 *  - "subject"      : un thème court (« inode walk ») → exo sur ce thème.
 *  - "statement"    : la consigne COMPLÈTE d'un exo raté → exo NEUF, même technique, setup différent.
 *  - "weakness_log" : un dump de lacunes (« j'ai pas compris X, raté Y, je confonds Z… »)
 *                     → extraire les concepts faibles (créés en faiblesses) + cibler le plus faible.
 *
 * UNE passe Max renvoie tout (kind + focus + faiblesses), pour ne pas multiplier les appels.
 */
export type IntakeWeakness = { topic: string; description: string; severity: number };
export type IntakeClass = {
  kind: "subject" | "statement" | "weakness_log";
  focus: string; // le sujet/technique à cibler (court)
  weaknesses: IntakeWeakness[]; // non vide seulement pour weakness_log
};

const INTAKE_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", description: "« subject » (thème court) | « statement » (la consigne complète d'UN exercice) | « weakness_log » (un dump de lacunes/incompréhensions de l'étudiant)." },
    focus: { type: "string", description: "Le sujet/la technique CS-202 à cibler, court (ex. « TCP slow start + perte », « inode walk frontière directe→indirecte »)." },
    weaknesses: {
      type: "array",
      description: "UNIQUEMENT si kind=weakness_log : la liste des points faibles distincts extraits du dump.",
      items: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Le concept faible (court)." },
          description: { type: "string", description: "Ce que l'étudiant n'a pas compris / a raté (1 phrase)." },
          severity: { type: "integer", description: "Gravité 1 (léger) à 3 (bloquant)." },
        },
        required: ["topic", "description", "severity"],
        additionalProperties: false,
      },
    },
  },
  required: ["kind", "focus", "weaknesses"],
  additionalProperties: false,
} as const;

/** Heuristique : un texte « riche » (long ou multi-lignes) mérite une classification. */
export function isRichText(t: string): boolean {
  const s = (t ?? "").trim();
  return s.length > 160 || s.split("\n").length >= 3;
}

/** Classe le texte d'entrée (1 appel Max). Pour un texte court, renvoie directement subject. */
export async function classifyTargetText(text: string): Promise<IntakeClass> {
  const t = (text ?? "").trim();
  if (!isRichText(t)) return { kind: "subject", focus: t, weaknesses: [] };
  const prompt = [
    `Tu es l'assistant d'étude CS-202 (EPFL). Classe le TEXTE D'ENTRÉE ci-dessous, qu'un étudiant colle pour générer un exercice ciblé.`,
    ``,
    `Décide son TYPE :`,
    `  - « subject » : un thème/sujet court (même s'il fait quelques mots).`,
    `  - « statement » : c'est la CONSIGNE / l'ÉNONCÉ COMPLET d'UN exercice (souvent avec sous-questions, chiffres, « calculez », un schéma décrit). On en fera un exo NEUF du même type.`,
    `  - « weakness_log » : un DUMP de lacunes/incompréhensions (« j'ai pas compris…, j'ai raté…, je confonds… », plusieurs points, ton de journal). On en extraira les faiblesses.`,
    ``,
    `Donne aussi « focus » = le sujet/la technique CS-202 à cibler en priorité (court).`,
    `Si « weakness_log » : remplis « weaknesses » avec chaque point faible distinct (topic court + description 1 phrase + gravité 1-3). Sinon « weaknesses » = [].`,
    ``,
    `═══ TEXTE D'ENTRÉE ═══`,
    t.slice(0, 6000),
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON conforme. Aucun fichier.`,
    JSON.stringify(INTAKE_SCHEMA, null, 2),
  ].join("\n");
  try {
    const r = extractJson<IntakeClass>(await runClaudeCode({ prompt, model: "opus", timeoutMs: 180_000 }));
    if (!["subject", "statement", "weakness_log"].includes(r.kind)) r.kind = "subject";
    if (!Array.isArray(r.weaknesses)) r.weaknesses = [];
    if (!r.focus) r.focus = t.slice(0, 120);
    return r;
  } catch {
    // repli sûr : on traite comme un sujet (jamais d'échec dur de l'entrée)
    return { kind: "subject", focus: t.slice(0, 200), weaknesses: [] };
  }
}
