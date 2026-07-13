/**
 * Interface provider LLM unique (Phase A backend-overhaul).
 *
 * TOUT appel au modèle passe par `complete()` (lib/llm/index.ts) qui choisit le
 * provider via `LLM_PROVIDER` (défaut : claude-code = headless `claude -p` via
 * l'abonnement Max, gratuit — comportement historique inchangé).
 *
 * Invariants hérités de lib/claude-code.ts, à préserver dans tout provider :
 *  - un échec REJETTE (throw LlmError) — jamais de valeur par défaut silencieuse :
 *    les ~8 fallbacks des call sites (verify → null « non vérifié », intake →
 *    kind='subject', eval → 'uncertain'…) reposent sur le throw.
 *  - codes d'erreur load-bearing : 'UNAVAILABLE' (→ HTTP 503), 'TIMEOUT'.
 */

/** Modèle logique. Les ids complets passent tels quels (mapping par provider/env). */
export type LlmModel = "opus" | "sonnet" | "haiku" | (string & {});

export type LlmImage = {
  /** ex. "image/png" */
  mediaType: string;
  /** contenu encodé base64 (sans préfixe data:) */
  base64: string;
};

export type CompleteRequest = {
  /** Prompt utilisateur unique (les call sites historiques n'ont PAS de system prompt). */
  prompt: string;
  /** System prompt optionnel (aucun call site historique n'en passe — nouveau, opt-in). */
  system?: string;
  /** Défaut : "opus" (comportement historique — meilleure vision). */
  model?: LlmModel;
  /** Timeout par appel. Défaut : celui du provider (claude-code : 180 s). */
  timeoutMs?: number;
  /** Budget de sortie (providers API seulement ; claude-code l'ignore). */
  maxTokens?: number;
  /**
   * Sortie JSON structurée (providers API : output_config json_schema /
   * response_format). Le provider claude-code l'IGNORE : les call sites
   * historiques dumpent le schéma dans le prompt et parsent via extractJson().
   */
  json?: { schema: object; effort?: "low" | "medium" | "high" };
  /** Mode de réflexion (providers Anthropic seulement). */
  thinking?: "adaptive";
  /**
   * Dossiers lisibles par l'outil Read au-delà du cwd (provider claude-code
   * SEULEMENT — c'est la « vision par chemins de fichiers » historique).
   * Les providers API lèvent UNSUPPORTED si présent (échec bruyant > silencieux).
   */
  addDirs?: string[];
  /** Vision base64 (providers API). claude-code lève UNSUPPORTED si présent. */
  images?: LlmImage[];
  /** Annulation coopérative. */
  signal?: AbortSignal;
};

export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type CompleteResult = {
  /** Texte final du modèle (les call sites parsent eux-mêmes : extractJson / texte libre). */
  text: string;
  usage?: LlmUsage;
  /** Provider qui a réellement servi l'appel (métriques/diagnostic). */
  provider: string;
  /** Modèle résolu réellement demandé au backend. */
  model: string;
};

/**
 * Erreur unique du moteur LLM.
 * codes : "TIMEOUT" | "UNAVAILABLE" | "ABORTED" | "RATE_LIMIT" | "OVERLOADED" |
 *         "AUTH" | "UNSUPPORTED" | undefined (erreur générique du backend).
 */
export class LlmError extends Error {
  code?: string;
  /** true → un retry a du sens (429/5xx/réseau). Les échecs métier restent false. */
  retryable: boolean;
  constructor(message: string, code?: string, retryable = false) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface LlmProvider {
  readonly name: string;
  /** Le provider peut-il servir un appel maintenant ? (binaire présent / clé posée / URL posée) */
  available(): boolean;
  /** Raison humaine si indisponible (messages d'erreur UI). */
  unavailableReason(): string | null;
  complete(req: CompleteRequest): Promise<CompleteResult>;
}
