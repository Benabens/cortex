import { assertSpendCap, closeUsage, discardUsage, openUsage } from "@/lib/billing/usage";
import { callerSite, currentJob } from "@/lib/billing/usage-context";
import { inc, log, observe } from "@/lib/metrics";
import { cacheGet, cacheKey, cachePut, cacheable } from "./cache";
import { defaultProviderName, mapModel, maxRetries, retryBaseMs, type ProviderName } from "./config";
import { globalLimiter } from "./limiter";
import { anthropicProvider } from "./providers/anthropic-api";
import { claudeCodeProvider } from "./providers/claude-code";
import { openaiCompatibleProvider } from "./providers/openai-compatible";
import { withRetry } from "./retry";
import { LlmError, type CompleteRequest, type CompleteResult, type LlmProvider } from "./types";

/**
 * Point d'entrée UNIQUE des appels LLM de l'app.
 *
 *   const { text } = await complete({ prompt, model: "opus", timeoutMs: 480_000 });
 *   const out = await completeText({ prompt });               // raccourci texte
 *   const spec = extractJson<MonType>(out);                    // parsing tolérant
 *
 * Provider choisi par LLM_PROVIDER (défaut claude-code = CLI local `claude -p`, sans clé API).
 * Enveloppe chaque appel : limiteur de concurrence global (LLM_MAX_CONCURRENCY)
 * + retries backoff/jitter des erreurs retryable (LLM_MAX_RETRIES).
 *
 * `completeVia("anthropic", req)` force un provider précis — pour les chemins
 * explicitement « API payante » historiques (bouton analyse API, generateExam API).
 */

/** Erreurs où le fournisseur n'a rien traité (donc rien facturé) : la ligne provisoire est retirée. */
const DISCARD_CODES = new Set(["RATE_LIMIT", "OVERLOADED", "AUTH", "UNSUPPORTED", "UNAVAILABLE", "SPEND_CAP", "UPSTREAM", "NETWORK"]);

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
  const model = req.model ?? "opus";
  const labels = { provider: provider.name, model };
  // Attribution (llm_usage) : site d'appel capturé AVANT tout await (pile sync),
  // job courant s'il y en a un (jobs = 1 par process).
  const callSite = callerSite();
  const job = currentJob();

  // Cache par hash de contenu (opt-in CACHE_ENABLED) — hit = zéro appel modèle.
  const key = cacheable(req) ? cacheKey(provider.name, req) : null;
  if (key) {
    const hit = await cacheGet(key);
    if (hit) {
      inc("cortex_llm_cache_total", { ...labels, result: "hit" });
      log("debug", "llm.cache_hit", labels);
      return hit;
    }
    inc("cortex_llm_cache_total", { ...labels, result: "miss" });
  }

  // KILL-SWITCH plafond de dépense (providers payants seulement ; un hit cache
  // au-dessus reste servi gratuitement même plafond atteint).
  await assertSpendCap(provider.name);

  const retries = maxRetries(provider.name as ProviderName);
  const t0 = Date.now();
  const siteLabel = job ? `${job.type}:${callSite ?? "?"}` : callSite;
  // COMPTAGE EN VOL (cf. lib/billing/usage openUsage) : chaque tentative est
  // écrite comme ligne estimée AVANT l'envoi, finalisée avec les compteurs
  // réels au retour, gardée telle quelle si le fournisseur a facturé sans
  // répondre (timeout, annulation en vol), retirée s'il a refusé avant de
  // traiter (429, 5xx, auth). Un worker tué en plein appel laisse une trace.
  const tokensInEstimate = Math.ceil((req.prompt.length + (req.system?.length ?? 0)) / 4);
  const modelId = mapModel(model, provider.name as ProviderName);
  try {
    const res = await globalLimiter().run(() =>
      withRetry(async (a) => {
        const pending = await openUsage({
          provider: provider.name, model: modelId,
          tokensIn: tokensInEstimate, tokensOut: req.maxTokens ?? 16_000,
          callSite: siteLabel, jobId: job?.id ?? null, attempt: a,
        });
        try {
          const r = await provider.complete(req);
          await closeUsage(pending, {
            provider: r.provider ?? provider.name, model: r.model ?? modelId,
            tokensIn: r.usage?.inputTokens, tokensOut: r.usage?.outputTokens,
            cacheRead: r.usage?.cacheReadTokens, cacheWrite: r.usage?.cacheWriteTokens,
            latencyMs: Date.now() - t0,
          });
          return r;
        } catch (e) {
          // Retirée seulement sur un refus IDENTIFIÉ avant traitement ; toute
          // autre erreur (timeout, annulation, coupure en cours de flux, réponse
          // tronquée, inconnue) garde l'estimation : mieux vaut surcompter.
          const code = e instanceof LlmError ? e.code : undefined;
          if (code && DISCARD_CODES.has(code)) await discardUsage(pending);
          throw e;
        }
      }, {
        retries,
        baseMs: retryBaseMs(),
        signal: req.signal,
        label: `${provider.name}/${model}`,
      })
    );
    const ms = Date.now() - t0;
    inc("cortex_llm_calls_total", { ...labels, result: "ok" });
    observe("cortex_llm_duration_ms", ms, labels);
    if (res.usage?.inputTokens) inc("cortex_llm_input_tokens_total", labels, res.usage.inputTokens);
    if (res.usage?.outputTokens) inc("cortex_llm_output_tokens_total", labels, res.usage.outputTokens);
    log("info", "llm.call", { ...labels, ms, in: res.usage?.inputTokens, out: res.usage?.outputTokens });
    if (key) await cachePut(key, res);
    return res;
  } catch (e) {
    const code = e instanceof LlmError ? e.code ?? "error" : "error";
    inc("cortex_llm_calls_total", { ...labels, result: code });
    observe("cortex_llm_duration_ms", Date.now() - t0, labels);
    log("warn", "llm.error", { ...labels, code, message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    throw e;
  }
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
