import type { LlmModel } from "./types";

/**
 * Configuration du moteur LLM — 100 % pilotée par variables d'environnement,
 * défauts = comportement historique (claude-code, aucune clé requise).
 * Voir .env.example pour la liste commentée.
 */

export const PROVIDER_NAMES = ["claude-code", "anthropic", "openai-compatible"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** Provider par défaut de l'app (env LLM_PROVIDER, défaut claude-code = dev €0). */
export function defaultProviderName(): ProviderName {
  const raw = (process.env.LLM_PROVIDER ?? "").trim();
  if (!raw) return "claude-code";
  if ((PROVIDER_NAMES as readonly string[]).includes(raw)) return raw as ProviderName;
  throw new Error(
    `LLM_PROVIDER invalide : « ${raw} » (attendu : ${PROVIDER_NAMES.join(" | ")})`
  );
}

/** Clé API pour les providers API (LLM_API_KEY prioritaire, repli ANTHROPIC_API_KEY). */
export function apiKey(): string | undefined {
  return process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY || undefined;
}

/** Endpoint des providers API (openai-compatible : requis ; anthropic : optionnel, tests). */
export function baseUrl(): string | undefined {
  return process.env.LLM_BASE_URL || undefined;
}

const MODEL_ENV: Record<string, string> = {
  opus: "LLM_MODEL_OPUS",
  sonnet: "LLM_MODEL_SONNET",
  haiku: "LLM_MODEL_HAIKU",
};

/** Ids par défaut côté API Anthropic (alignés sur l'historique GEN_MODEL pour opus). */
const ANTHROPIC_DEFAULTS: Record<string, string> = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
};

/**
 * Mappe un modèle logique ('opus' | 'sonnet' | 'haiku') vers l'id du backend.
 *  - env LLM_MODEL_<X> prioritaire (tous providers) ;
 *  - claude-code : passthrough (le CLI comprend les alias — comportement historique) ;
 *  - anthropic : ids par défaut ci-dessus ;
 *  - openai-compatible : passthrough (mapper via env, cf. .env.example).
 * Un id complet (non logique) passe toujours tel quel.
 */
export function mapModel(model: LlmModel, provider: ProviderName): string {
  const envKey = MODEL_ENV[model];
  if (envKey && process.env[envKey]) return process.env[envKey]!;
  if (provider === "anthropic" && ANTHROPIC_DEFAULTS[model]) {
    // RÈGLE D'OR coûts (déploiement v1) : sur le provider API PAYANT, l'alias
    // logique « opus » ne se résout vers Opus (5×/25× plus cher que Sonnet en
    // sortie) que si EXPLICITEMENT autorisé — LLM_ALLOW_OPUS=1 ou LLM_MODEL_OPUS
    // posé. Sinon Sonnet. Le provider claude-code (dev €0 via Max) garde le
    // passthrough historique : « opus » y reste opus.
    if (model === "opus" && process.env.LLM_ALLOW_OPUS !== "1") return ANTHROPIC_DEFAULTS.sonnet;
    return ANTHROPIC_DEFAULTS[model];
  }
  return model;
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

/** Concurrence max des appels LLM (limiteur global). */
export function maxConcurrency(): number {
  return Math.max(1, envInt("LLM_MAX_CONCURRENCY", 4));
}

/**
 * Nombre de RE-tentatives après un échec retryable.
 * Défaut : 0 pour claude-code (comportement historique — les call sites ont leurs
 * propres fallbacks calibrés), 2 pour les providers API (429/5xx fréquents).
 */
export function maxRetries(provider: ProviderName): number {
  return envInt("LLM_MAX_RETRIES", provider === "claude-code" ? 0 : 2);
}

export function retryBaseMs(): number {
  return envInt("LLM_RETRY_BASE_MS", 500);
}
