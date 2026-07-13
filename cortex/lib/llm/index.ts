import { defaultProviderName, maxRetries, retryBaseMs, type ProviderName } from "./config";
import { globalLimiter } from "./limiter";
import { anthropicProvider } from "./providers/anthropic-api";
import { claudeCodeProvider } from "./providers/claude-code";
import { openaiCompatibleProvider } from "./providers/openai-compatible";
import { withRetry } from "./retry";
import type { CompleteRequest, CompleteResult, LlmProvider } from "./types";

/**
 * Point d'entrée UNIQUE des appels LLM de l'app.
 *
 *   const { text } = await complete({ prompt, model: "opus", timeoutMs: 480_000 });
 *   const out = await completeText({ prompt });               // raccourci texte
 *   const spec = extractJson<MonType>(out);                    // parsing tolérant
 *
 * Provider choisi par LLM_PROVIDER (défaut claude-code = `claude -p` via Max, €0).
 * Enveloppe chaque appel : limiteur de concurrence global (LLM_MAX_CONCURRENCY)
 * + retries backoff/jitter des erreurs retryable (LLM_MAX_RETRIES).
 *
 * `completeVia("anthropic", req)` force un provider précis — pour les chemins
 * explicitement « API payante » historiques (bouton analyse API, generateExam API).
 */

const REGISTRY: Record<ProviderName, LlmProvider> = {
  "claude-code": claudeCodeProvider,
  anthropic: anthropicProvider,
  "openai-compatible": openaiCompatibleProvider,
};

/** Provider par défaut (env) ou nommé. */
export function getProvider(name?: ProviderName): LlmProvider {
  return REGISTRY[name ?? defaultProviderName()];
}

/** Le moteur par défaut peut-il servir un appel ? (remplace les gardes claudeBinPath()). */
export function llmAvailable(name?: ProviderName): boolean {
  return getProvider(name).available();
}

/** Raison humaine si le moteur est indisponible (messages UI/CLI). */
export function llmUnavailableReason(name?: ProviderName): string | null {
  return getProvider(name).unavailableReason();
}

async function completeWith(provider: LlmProvider, req: CompleteRequest): Promise<CompleteResult> {
  const retries = maxRetries(provider.name as ProviderName);
  return globalLimiter().run(() =>
    withRetry(() => provider.complete(req), {
      retries,
      baseMs: retryBaseMs(),
      signal: req.signal,
      label: `${provider.name}/${req.model ?? "opus"}`,
    })
  );
}

/** Appel LLM via le provider par défaut (env LLM_PROVIDER). */
export function complete(req: CompleteRequest): Promise<CompleteResult> {
  return completeWith(getProvider(), req);
}

/** Appel LLM via un provider explicite (chemins « API payante » historiques). */
export function completeVia(name: ProviderName, req: CompleteRequest): Promise<CompleteResult> {
  return completeWith(getProvider(name), req);
}

/** Raccourci : texte final seul (l'écrasante majorité des call sites). */
export async function completeText(req: CompleteRequest): Promise<string> {
  return (await complete(req)).text;
}

export { extractJson } from "../claude-code";
export { PROVIDER_NAMES, type ProviderName } from "./config";
export { LlmError } from "./types";
export type { CompleteRequest, CompleteResult, LlmImage, LlmModel, LlmProvider, LlmUsage } from "./types";
