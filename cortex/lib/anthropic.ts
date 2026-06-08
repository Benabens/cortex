import Anthropic from "@anthropic-ai/sdk";

/**
 * Client Claude partagé. La clé vient de .env.local (ANTHROPIC_API_KEY), jamais commitée.
 * Utilisé pour : analyse des faiblesses + génération d'examens.
 */
let _client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY manquante. Ajoute-la dans cortex/.env.local (cf. .env.example)."
    );
  }
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// Modèle par défaut pour la génération (révisable).
export const GEN_MODEL = "claude-sonnet-4-5";
