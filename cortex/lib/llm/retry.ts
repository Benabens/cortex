import { LlmError } from "./types";

/**
 * Retries avec backoff exponentiel + jitter. Ne réessaie QUE les erreurs
 * marquées retryable (LlmError.retryable) — les échecs métier (sortie illisible,
 * exclusion violée…) remontent immédiatement aux fallbacks des call sites.
 */

export type RetryOpts = {
  /** Nombre de RE-tentatives (0 = un seul essai, comportement historique claude-code). */
  retries: number;
  /** Base du backoff (délai ~ base·2^n avec jitter plein). Défaut 500 ms. */
  baseMs?: number;
  /** Plafond du délai entre tentatives. Défaut 15 000 ms. */
  maxMs?: number;
  signal?: AbortSignal;
  /** Étiquette pour le log d'échec (nom du provider / du site d'appel). */
  label?: string;
  /** Appelé pour CHAQUE tentative échouée (retryée ou non) — comptage de coût des appels perdus. */
  onAttemptError?: (attempt: number, err: unknown) => void | Promise<void>;
};

export function isRetryable(e: unknown): boolean {
  return e instanceof LlmError && e.retryable === true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): LlmError {
  return new LlmError("Appel LLM annulé.", "ABORTED");
}

/** Délai de la tentative n (0-indexée) : backoff exponentiel, jitter plein, plafonné. */
export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number, rand: () => number = Math.random): number {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(cap * (0.5 + rand() * 0.5));
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOpts): Promise<T> {
  const { retries, baseMs = 500, maxMs = 15_000, signal, label = "llm", onAttemptError } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw abortError();
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (onAttemptError) { try { await onAttemptError(attempt, e); } catch { /* jamais bloquant */ } }
      const canRetry = attempt < retries && isRetryable(e);
      if (!canRetry) break;
      const delay = backoffDelayMs(attempt, baseMs, maxMs);
      console.error(
        `[llm] ${label} : tentative ${attempt + 1}/${retries + 1} échouée (${e instanceof Error ? e.message : e}) — retry dans ${delay} ms`
      );
      await sleep(delay, signal);
    }
  }
  if (lastErr instanceof LlmError && retries > 0 && lastErr.retryable) {
    console.error(`[llm] ${label} : échec définitif après ${retries + 1} tentatives : ${lastErr.message}`);
  }
  throw lastErr;
}
