import { assertSpendCap, closeUsage, discardUsage, openUsage } from "@/lib/billing/usage";
import { callerSite, currentJob } from "@/lib/billing/usage-context";
import { inc, log, observe } from "@/lib/metrics";
import { cacheGet, cacheKey, cachePut, cacheable } from "./cache";
import { defaultProviderName, mapModel, maxRetries, retryBaseMs, type ProviderName } from "./config";
import { globalLimiter } from "./limiter";
import { anthropicProvider } from "./providers/anthropic-api";
import { claudeCodeProvider } from "./providers/claude-code";
import { codexCliProvider } from "./providers/codex-cli";
import { openaiCompatibleProvider } from "./providers/openai-compatible";
import { withRetry } from "./retry";
import { nextRank, recordCall, replayCall, tapeMode } from "./tape";
import { extractJson, JsonOutputError } from "./json";
import { LlmError, type CompleteRequest, type CompleteResult, type LlmProvider } from "./types";
import { assertLlmAuthorized } from "./authorization";

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
  "codex-cli": codexCliProvider,
  anthropic: anthropicProvider,
  "openai-compatible": openaiCompatibleProvider,
};

/** Provider par défaut (env) ou nommé. */
export function getProvider(name?: ProviderName): LlmProvider {
  return REGISTRY[name ?? defaultProviderName()];
}

/** Le moteur par défaut peut-il servir un appel ? (remplace les gardes claudeBinPath()). */
export function llmAvailable(name?: ProviderName): boolean {
  // Banc en rejeu : la bande répond à la place du fournisseur (CI sans CLI ni clé).
  if (tapeMode()?.mode === "replay") return true;
  return getProvider(name).available();
}

/** Raison humaine si le moteur est indisponible (messages UI/CLI). */
export function llmUnavailableReason(name?: ProviderName): string | null {
  if (tapeMode()?.mode === "replay") return null;
  return getProvider(name).unavailableReason();
}

async function completeWith(provider: LlmProvider, req: CompleteRequest): Promise<CompleteResult> {
  const model = req.model ?? "opus";
  const labels = { provider: provider.name, model };
  // Attribution (llm_usage) : site d'appel capturé AVANT tout await (pile sync),
  // job courant s'il y en a un (jobs = 1 par process).
  const callSite = callerSite();
  const job = currentJob();
  await assertLlmAuthorized();
  // Banc (scripts/bench) : bande enregistrée ou rejouée ; rejeu = aucun appel, aucun compteur.
  const tape = tapeMode();
  const tapeSite = callSite ?? "?";
  const tapeRank = tape ? nextRank(tape.file, tapeSite) : 0;
  if (tape?.mode === "replay") return replayCall(tape, req, tapeSite, tapeRank);

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
        const tCall = Date.now();
        try {
          const r = await provider.complete(req);
          if (tape) recordCall(tape, req, tapeSite, tapeRank, Date.now() - tCall, { result: r });
          await closeUsage(pending, {
            provider: r.provider ?? provider.name, model: r.model ?? modelId,
            tokensIn: r.usage?.inputTokens, tokensOut: r.usage?.outputTokens,
            cacheRead: r.usage?.cacheReadTokens, cacheWrite: r.usage?.cacheWriteTokens,
            latencyMs: Date.now() - t0,
          });
          return r;
        } catch (e) {
          if (tape) recordCall(tape, req, tapeSite, tapeRank, Date.now() - tCall, { error: e });
          // Retirée seulement sur un refus IDENTIFIÉ avant traitement ; toute
          // autre erreur (timeout, annulation, coupure en cours de flux, réponse
          // tronquée, inconnue) garde l'estimation : mieux vaut surcompter.
          const code = e instanceof LlmError ? e.code : undefined;
          if (code && DISCARD_CODES.has(code)) await discardUsage(pending);
          // Réponse facturée mais inutilisable (coupée, refusée) : compteurs réels.
          else if (e instanceof LlmError && e.usage) {
            await closeUsage(pending, {
              provider: provider.name, model: modelId,
              tokensIn: e.usage.inputTokens, tokensOut: e.usage.outputTokens,
              cacheRead: e.usage.cacheReadTokens, cacheWrite: e.usage.cacheWriteTokens,
              latencyMs: Date.now() - t0,
            });
          }
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

/** Nombre d'essais par défaut de completeJson (le premier compris). */
export const JSON_ATTEMPTS = 3;

/** Motif de rejet d'une réponse, ou null si elle n'est pas en cause (erreur du fournisseur). */
function rejection(e: unknown): { reason: string; truncated: boolean } | null {
  if (e instanceof JsonOutputError) return { reason: e.message, truncated: e.truncated };
  if (e instanceof LlmError && e.code === "TRUNCATED") return { reason: e.message, truncated: true };
  return null;
}

/**
 * Appel dont la réponse doit être du JSON : lit la réponse (extractJson) et la
 * valide (`check` → motif de rejet, ou null). Une réponse illisible, coupée ou
 * de mauvaise forme est REDEMANDÉE avec le motif précis ajouté au prompt — un
 * rejeu à l'identique redonne la même erreur (et la même réponse en cache).
 * Les erreurs du fournisseur (429, 5xx, réseau) sont réessayées plus bas
 * (completeWith) et remontent telles quelles. Après `attempts` essais :
 * LlmError BAD_OUTPUT. Passer `json` à la requête active en plus la sortie
 * structurée des fournisseurs API, qui supprime l'essentiel de ces rejets.
 */
export async function completeJson<T = unknown>(
  req: CompleteRequest,
  opts: { attempts?: number; check?: (value: T) => string | null | Promise<string | null> } = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? JSON_ATTEMPTS);
  let last = "";
  for (let n = 1; n <= attempts; n++) {
    const prompt = n === 1 ? req.prompt : `${req.prompt}\n\n${retryNote(last, n, attempts)}`;
    try {
      const value = extractJson<T>((await complete({ ...req, prompt })).text);
      const issue = (await opts.check?.(value)) ?? null;
      if (!issue) return value;
      last = `réponse JSON lisible mais incomplète : ${issue}`;
    } catch (e) {
      const r = rejection(e);
      if (!r) throw e;
      last = r.truncated ? `${r.reason} Sois plus concis (explications plus courtes) pour que la réponse tienne en entier.` : r.reason;
    }
    console.error(`[llm] réponse JSON rejetée (essai ${n}/${attempts}) : ${last.slice(0, 200)}`);
  }
  throw new LlmError(`Le modèle a renvoyé une réponse illisible ${attempts} fois de suite (${last.slice(0, 200)}).`, "BAD_OUTPUT");
}

function retryNote(reason: string, n: number, attempts: number): string {
  return [
    `ATTENTION (essai ${n}/${attempts}) : ta réponse précédente n'était pas un JSON valide utilisable — ${reason}`,
    `Renvoie UNIQUEMENT la valeur JSON demandée, complète : aucun texte autour, pas de bloc markdown. Dans les chaînes, échappe les guillemets (\\"), les antislashs (\\\\) et les retours à la ligne (\\n), y compris dans le code et le LaTeX.`,
  ].join("\n");
}

export { extractJson, JsonOutputError } from "./json";
export { BAD_OUTPUT_CODES, HARD_STOP_CODES, OWN_LLM_CODES, PROVIDER_DOWN_CODES, llmErrorCode, llmFailureReason, llmUserMessage } from "./errors";
export { PROVIDER_NAMES, type ProviderName } from "./config";
export { LlmError } from "./types";
export type { CompleteRequest, CompleteResult, LlmImage, LlmModel, LlmProvider, LlmUsage } from "./types";
