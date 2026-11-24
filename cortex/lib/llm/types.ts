import type { UserError } from "@/lib/i18n/user-error";

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

export type LlmEffort = "low" | "medium" | "high";

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
  json?: { schema: object };
  /**
   * Profondeur de réflexion du site d'appel (anthropic : output_config.effort ; codex-cli :
   * model_reasoning_effort). Absent : défaut du modèle — « high » sur Sonnet 5, dont la réflexion
   * adaptive facturait 8 à 15 k tokens par appel en prod (13-14/11) pour 1 à 2,5 k de réponse.
   */
  effort?: LlmEffort;
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
  /**
   * Interne : l'appel est une aide payée (drill, correction). Posé par lib/llm complete() depuis la
   * preuve d'autorisation, jamais par l'appelant : LLM_ALLOW_OPUS=assist y autorise Opus.
   */
  assist?: boolean;
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
  userError?: UserError;
  constructor(message: string, code?: string, retryable = false, usage?: LlmUsage, userError?: UserError) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.retryable = retryable;
    if (usage) this.usage = usage;
    if (userError) this.userError = userError;
    // La raison précise (clé manquante, CLI introuvable…) : c'est elle que l'exploitant doit lire.
    else if (code === "UNAVAILABLE") this.userError = message ? { code: "llm_engine_unavailable_reason", params: { reason: message } } : { code: "llm_engine_unavailable" };
    else if (code === "SPEND_CAP") this.userError = { code: "llm_spend_cap" };
    else if (code === "QUOTA") this.userError = { code: "llm_quota_reached" };
    else if (code === "CREDITS") this.userError = { code: "billing_balance_empty" };
  }
}

/** Réponse coupée par max_tokens : jamais rendue comme un texte complet (cf. lib/llm/json). */
export function truncatedError(maxTokens: number | undefined, usage?: LlmUsage): LlmError {
  return new LlmError(`Réponse du modèle coupée par la limite de longueur (${maxTokens ?? DEFAULT_MAX_TOKENS} tokens).`, "TRUNCATED", false, usage);
}

/** Budget de sortie par défaut des providers API. */
export const DEFAULT_MAX_TOKENS = 16_000;

/**
 * Sortie d'un appel qui réfléchit longuement : à l'effort par défaut, la réflexion de Sonnet 5
 * coupait la réponse à DEFAULT_MAX_TOKENS (prod du 13 au 15/11 : 19,7 % de la dépense des QCM
 * de HUM-285 facturés sur des appels coupés ; 10 lots d'examen sur 11, job 2).
 */
export const LONG_OUTPUT_MAX_TOKENS = 32_000;

/**
 * Sortie d'un appel d'examen écrit qui conçoit, régénère ou revérifie un exercice entier (lib/exam,
 * lib/verify). Banc cs-202-ecrit du 16 au 17/11 (claude-code, qui ignore la limite) : un lot jusqu'à
 * 62 k tokens (57 % au-dessus de 32 k), une régénération 30 k en moyenne (toutes au-dessus de 16 k),
 * une vérification qui réécrit le corrigé 19 k en moyenne (65 % au-dessus de 16 k). Une limite
 * plus haute ne coûte rien de plus : seule la sortie produite est facturée, pas la limite.
 */
export const EXAM_OUTPUT_MAX_TOKENS = 64_000;

/**
 * Effort des sites difficiles (rédaction, correction, vérification) qui ne fixent pas le leur.
 * Sur Sonnet 5 ils tournaient à son défaut, « high ». Banc jugé du 23/11/2026, clés justes :
 *  - examen écrit CS-202 (8 exercices) : Sonnet 5 high 2/8, Opus 5.5 medium 4/8, Opus 5.5 high 5/8 ;
 *  - QCM ML (23 questions) : Sonnet 5 high 15/23, Opus 5.5 medium 18/23, Opus 5.5 high 20/23.
 * « high » coûte plus (examen 9,2 à 12,6 $ contre 4,6 à 7,9 $ ; QCM 7,3 $ contre 5,7 $) : les prix
 * en crédits (lib/billing/credits) sont calés sur son p95, « medium » ne fait donc qu'élargir la
 * marge. LLM_HARD_EFFORT le règle sans redéploiement (low, medium, high) ; une valeur inconnue
 * garde le défaut.
 */
export const HARD_TASK_EFFORT_DEFAULT: LlmEffort = "high";
const isEffort = (v: string | undefined): v is "low" | "medium" | "high" => v === "low" || v === "medium" || v === "high";

/**
 * `site` (nom de la fonction appelante, celui des bandes du banc) permet de régler une seule étape :
 * LLM_EFFORT_BY_SITE="reviseFromAudit=medium,designTrap=medium" passe avant LLM_HARD_EFFORT. Sans
 * cette variable, rien ne change ; un site absent ou une valeur inconnue garde l'effort commun.
 */
export function hardTaskEffort(site?: string): LlmEffort {
  if (site) {
    for (const pair of (process.env.LLM_EFFORT_BY_SITE ?? "").split(",")) {
      const [k, v] = pair.split("=").map((x) => x.trim());
      const level = v?.toLowerCase();
      if (k === site && isEffort(level)) return level;
    }
  }
  const v = process.env.LLM_HARD_EFFORT?.trim().toLowerCase();
  return isEffort(v) ? v : HARD_TASK_EFFORT_DEFAULT;
}

export interface LlmProvider {
  readonly name: string;
  /** Le provider peut-il servir un appel maintenant ? (binaire présent / clé posée / URL posée) */
  available(): boolean;
  /** Raison humaine si indisponible (messages d'erreur UI). */
  unavailableReason(): string | null;
  complete(req: CompleteRequest): Promise<CompleteResult>;
}
