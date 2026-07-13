import { currentCourse } from "@/db/client";
import { completeText, extractJson } from "@/lib/llm";
import { getCourse } from "@/lib/courses";

/**
 * Mining de conversation (Phase 5, spec V2) : ce que Ben demande à Claude toute la journée
 * (questions, exos résolus, incompréhensions) EST la meilleure source de ses faiblesses.
 * Analyse une discussion collée → faiblesses structurées (topic, concept, gravité, thème, extrait),
 * classées par thème, prêtes à être auto-liées au corpus du cours et à piloter le blueprint.
 */
export type MinedWeakness = {
  topic: string;
  concept: string;
  theme: string;
  severity: number; // 1..3
  excerpt: string; // court passage de la discussion qui montre le blocage
};

const SCHEMA = {
  type: "object",
  properties: {
    weaknesses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Le point faible en 3-8 mots (ex. « TCP: ACK = prochain octet attendu »)." },
          concept: { type: "string", description: "Le concept/technique sous-jacent (ex. « TCP sequence numbers »)." },
          theme: { type: "string", description: "Grand thème de regroupement (ex. « Networking », « Dynamic Programming », « OS scheduling »)." },
          severity: { type: "integer", description: "1 (léger doute) à 3 (incompréhension nette / erreur répétée)." },
          excerpt: { type: "string", description: "Court extrait (1-2 phrases) de la discussion qui montre le blocage." },
        },
        required: ["topic", "concept", "theme", "severity"],
        additionalProperties: false,
      },
    },
  },
  required: ["weaknesses"],
  additionalProperties: false,
} as const;

/** Analyse une conversation et en extrait des faiblesses structurées (via Claude Code / Max). */
export async function mineConversation(text: string): Promise<MinedWeakness[]> {
  const c = getCourse(currentCourse());
  const prompt = [
    `Tu es un tuteur de ${c.examCode} ${c.examName} (${c.university}). On te donne une DISCUSSION (chat) entre un étudiant et un assistant.`,
    `Ta tâche : repérer TOUS les endroits où l'étudiant BUTE — questions répétées, incompréhensions, erreurs, confusions, « je ne comprends pas », corrections qu'on a dû lui faire.`,
    `Pour CHACUN, produis une faiblesse structurée : topic (court), concept sous-jacent, thème de regroupement, gravité (1-3), et un court extrait de la discussion.`,
    `Regroupe par CONCEPT : si l'étudiant bute plusieurs fois sur la même chose, UNE seule faiblesse (gravité plus élevée). Ne liste PAS ce qu'il a compris. Sois précis et orienté révision.`,
    `Limite-toi aux faiblesses RÉELLES et pédagogiquement utiles (max ~12).`,
    ``,
    `DISCUSSION :`,
    "```",
    text.slice(0, 60000),
    "```",
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON conforme. Aucun fichier, aucun outil, aucune prose.`,
    JSON.stringify(SCHEMA, null, 2),
  ].join("\n");
  const out = await completeText({ prompt, model: "opus", timeoutMs: 220_000 });
  const r = extractJson<{ weaknesses: MinedWeakness[] }>(out);
  const list = Array.isArray(r.weaknesses) ? r.weaknesses : [];
  return list
    .filter((w) => w.topic && w.concept)
    .slice(0, 12)
    .map((w) => ({
      topic: String(w.topic).slice(0, 200),
      concept: String(w.concept).slice(0, 200),
      theme: String(w.theme || "(non classé)").slice(0, 80),
      severity: Math.min(3, Math.max(1, Math.round(w.severity || 2))),
      excerpt: String(w.excerpt ?? "").slice(0, 400),
    }));
}
