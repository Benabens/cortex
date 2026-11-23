/**
 * Limites de l'outil gratuit « What's on my exam? ». Sans compte, chaque analyse est payée par
 * Cortex : contrairement aux autres garde-fous (lib/billing/env), AUCUNE de ces limites ne se
 * lève, même en dev ou par `unlimited` — une valeur absente ou illisible vaut son défaut, `0`
 * ferme l'outil (plafond) ou le quota.
 */

/** Pseudo-utilisateur de l'outil : sa dépense du jour, dans llm_usage, est le plafond quotidien. */
export const FREE_TOOL_USER = "free-tool";

/**
 * Interrupteur de l'outil, séparé des plafonds de dépense : absent ou toute valeur hors `1`/`true`
 * vaut fermé. Décision de Ben (23/11) : retiré pour l'instant, le code reste pour une démo plus tard.
 */
export function freeToolEnabled(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return env.FREE_TOOL_ENABLED === "1" || env.FREE_TOOL_ENABLED === "true";
}

function num(name: string, def: number, env: Partial<NodeJS.ProcessEnv>): number {
  const raw = env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

export type FreeToolLimits = {
  /** Dépense IA maximale de l'outil par jour UTC, toutes analyses confondues (USD). 0 = outil fermé. */
  dailyUsd: number;
  /** Dépense maximale d'UNE analyse (USD) ; une analyse n'est admise que si elle tient dans le reste du jour. */
  runUsd: number;
  /** Analyses admises par IP (groupe /64 en IPv6) sur 24 h glissantes. */
  perIpDay: number;
  /** Analyses simultanées (process unique). */
  maxConcurrent: number;
  maxFiles: number;
  maxFileBytes: number;
  maxPagesPerFile: number;
  /** Pages scannées envoyées en image au modèle, par analyse. */
  maxImagePages: number;
};

export function freeToolLimits(env: Partial<NodeJS.ProcessEnv> = process.env): FreeToolLimits {
  return {
    dailyUsd: num("FREE_TOOL_DAILY_USD", 3, env),
    runUsd: num("FREE_TOOL_RUN_USD", 0.35, env),
    perIpDay: Math.floor(num("FREE_TOOL_PER_IP_DAY", 3, env)),
    maxConcurrent: Math.max(1, Math.floor(num("FREE_TOOL_MAX_CONCURRENT", 2, env))),
    maxFiles: 3,
    maxFileBytes: 10 * 1024 * 1024,
    // Les vraies annales ont souvent 24 à 30 pages, pages de réponse vides comprises.
    maxPagesPerFile: 40,
    maxImagePages: 12,
  };
}

/** Une analyse qui tourne depuis plus longtemps est morte (redéploiement, crash) : elle compte comme échouée. */
export const RUN_STALE_MS = 10 * 60_000;
