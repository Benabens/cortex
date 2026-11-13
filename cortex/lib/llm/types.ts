/**
 * Interface provider LLM unique.
 *
 * TOUT appel au modèle passe par `complete()` (lib/llm/index.ts) qui choisit le
 * provider via `LLM_PROVIDER` (défaut : claude-code = headless `claude -p` via
 * la session CLI locale, sans clé API — comportement historique inchangé).
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
  path?: never;
} | {
  /** Chemin absolu d'une image locale (provider codex-cli uniquement). */
  path: string;
  mediaType?: never;
  base64?: never;
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
  /** Tokens lus depuis le cache de prompt Anthropic (facturés 0,1×). */
  cacheReadTokens?: number;
  /** Tokens écrits dans le cache de prompt (écriture 5 min, facturée 1,25×). */
  cacheWriteTokens?: number;
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
 *         "AUTH" | "UNSUPPORTED" | "TRUNCATED" (réponse coupée par max_tokens) |
 *         "REFUSAL" (refus du modèle) | "BAD_OUTPUT" (JSON illisible après réessais) |
 *         undefined (erreur générique du backend).
 */
export class LlmError extends Error {
  code?: string;
  /** true → un retry a du sens (429/5xx/réseau). Les échecs métier restent false. */
  retryable: boolean;
  /** Compteurs réels quand le fournisseur a répondu (et facturé) une réponse inutilisable. */
  usage?: LlmUsage;
  constructor(message: string, code?: string, retryable = false, usage?: LlmUsage) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.retryable = retryable;
    if (usage) this.usage = usage;
  }
}

/** Réponse coupée par max_tokens : jamais rendue comme un texte complet (cf. lib/llm/json). */
export function truncatedError(maxTokens: number | undefined, usage?: LlmUsage): LlmError {
  return new LlmError(`Réponse du modèle coupée par la limite de longueur (${maxTokens ?? DEFAULT_MAX_TOKENS} tokens).`, "TRUNCATED", false, usage);
}

/** Budget de sortie par défaut des providers API. */
export const DEFAULT_MAX_TOKENS = 16_000;

export interface LlmProvider {
  readonly name: string;
  /** Le provider peut-il servir un appel maintenant ? (binaire présent / clé posée / URL posée) */
  available(): boolean;
  /** Raison humaine si indisponible (messages d'erreur UI). */
  unavailableReason(): string | null;
  complete(req: CompleteRequest): Promise<CompleteResult>;
}
