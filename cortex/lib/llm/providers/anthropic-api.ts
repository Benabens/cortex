import Anthropic from "@anthropic-ai/sdk";
import { apiKey, baseUrl, mapModel } from "../config";
import { LlmError, type CompleteRequest, type CompleteResult, type LlmProvider } from "../types";

/**
 * Provider API Anthropic officielle (voie production, clé requise).
 * Toujours en streaming (mêmes contenus que create, sans timeout HTTP sur les
 * gros appels — même technique que l'historique lib/exam.ts callClaude).
 */

let _client: Anthropic | null = null;
let _clientKey: string | null = null;

function client(key: string): Anthropic {
  if (!_client || _clientKey !== key) {
    _client = new Anthropic({ apiKey: key, ...(baseUrl() ? { baseURL: baseUrl() } : {}) });
    _clientKey = key;
  }
  return _client;
}

/** Statuts HTTP qui justifient un retry (rate limit / surcharge / transitoire). */
function retryableStatus(status: number | undefined): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
}

function toLlmError(e: unknown): LlmError {
  const err = e as { status?: number; message?: string; name?: string };
  const msg = err?.message ? String(err.message) : String(e);
  if (err?.name === "AbortError") return new LlmError("Appel LLM annulé.", "ABORTED");
  const status = typeof err?.status === "number" ? err.status : undefined;
  if (status === 401 || status === 403) return new LlmError(msg, "AUTH");
  if (status === 429) return new LlmError(msg, "RATE_LIMIT", true);
  if (status === 529) return new LlmError(msg, "OVERLOADED", true);
  if (retryableStatus(status)) return new LlmError(msg, undefined, true);
  if (/timeout|timed out/i.test(msg)) return new LlmError(msg, "TIMEOUT", true);
  return new LlmError(msg);
}

export const anthropicProvider: LlmProvider = {
  name: "anthropic",

  available(): boolean {
    return !!apiKey();
  },

  unavailableReason(): string | null {
    return this.available()
      ? null
      : "ANTHROPIC_API_KEY manquante. Colle ta clé dans cortex/.env.local (ou pose LLM_API_KEY), puis relance le serveur.";
  },

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    if (req.addDirs?.length) {
      throw new LlmError(
        "Ce site d'appel repose sur la lecture de fichiers locaux (addDirs) — provider claude-code requis (LLM_PROVIDER=claude-code), ou adapte le site en images base64.",
        "UNSUPPORTED"
      );
    }
    const key = apiKey();
    if (!key) {
      // Message aligné sur l'historique lib/anthropic.ts (la route analyze mappe /ANTHROPIC_API_KEY/ → 400).
      throw new LlmError(this.unavailableReason()!, "UNAVAILABLE");
    }
    const model = mapModel(req.model ?? "opus", "anthropic");

    type Block =
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "base64"; media_type: string; data: string } };
    const content: Block[] = [
      // Images AVANT le texte (ordre historique de la route analyze).
      ...(req.images ?? []).map((im): Block => ({
        type: "image",
        source: { type: "base64", media_type: im.mediaType, data: im.base64 },
      })),
      { type: "text", text: req.prompt },
    ];

    const params: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? 16_000,
      messages: [{ role: "user", content }],
    };
    if (req.system) params.system = req.system;
    if (req.thinking === "adaptive") params.thinking = { type: "adaptive" };
    if (req.json) {
      params.output_config = {
        format: { type: "json_schema", schema: req.json.schema },
        ...(req.json.effort ? { effort: req.json.effort } : {}),
      };
    }

    try {
      const stream = client(key).messages.stream(
        params as Parameters<Anthropic["messages"]["stream"]>[0],
        { ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}), ...(req.signal ? { signal: req.signal } : {}) }
      );
      const msg = await stream.finalMessage();
      const textBlock = msg.content.find((b) => b.type === "text") as { text?: string } | undefined;
      return {
        text: textBlock?.text ?? "",
        usage: {
          inputTokens: msg.usage?.input_tokens ?? undefined,
          outputTokens: msg.usage?.output_tokens ?? undefined,
        },
        provider: this.name,
        model,
      };
    } catch (e) {
      throw toLlmError(e);
    }
  },
};
