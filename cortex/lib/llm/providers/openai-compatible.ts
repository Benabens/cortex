import { apiKey, baseUrl, mapModel } from "../config";
import { LlmError, type CompleteRequest, type CompleteResult, type LlmProvider } from "../types";

/**
 * Provider générique « OpenAI-compatible » : n'importe quel endpoint
 * /chat/completions (NVIDIA NIM build.nvidia.com, vLLM, Ollama, OpenRouter…).
 * Config : LLM_BASE_URL (requis) + LLM_API_KEY (si le endpoint l'exige) +
 * mapping modèles LLM_MODEL_OPUS/SONNET/HAIKU (recommandé — pas de défaut sensé).
 */

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export const openaiCompatibleProvider: LlmProvider = {
  name: "openai-compatible",

  available(): boolean {
    return !!baseUrl();
  },

  unavailableReason(): string | null {
    return this.available()
      ? null
      : "LLM_BASE_URL manquante (endpoint /chat/completions du fournisseur OpenAI-compatible).";
  },

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    if (req.addDirs?.length) {
      throw new LlmError(
        "Ce site d'appel repose sur la lecture de fichiers locaux (addDirs) — provider claude-code requis (LLM_PROVIDER=claude-code), ou adapte le site en images base64.",
        "UNSUPPORTED"
      );
    }
    const root = baseUrl();
    if (!root) throw new LlmError(this.unavailableReason()!, "UNAVAILABLE");
    const url = `${root.replace(/\/+$/, "")}/chat/completions`;
    const model = mapModel(req.model ?? "opus", "openai-compatible");

    const userContent = req.images?.length
      ? [
          ...req.images.map((im) => ({
            type: "image_url" as const,
            image_url: { url: `data:${im.mediaType};base64,${im.base64}` },
          })),
          { type: "text" as const, text: req.prompt },
        ]
      : req.prompt;

    const body: Record<string, unknown> = {
      model,
      messages: [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        { role: "user", content: userContent },
      ],
      max_tokens: req.maxTokens ?? 16_000,
    };
    if (req.json) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "output", schema: req.json.schema },
      };
    }

    const timeoutMs = req.timeoutMs ?? 180_000;
    const timeoutCtl = AbortController ? new AbortController() : null;
    const timer = setTimeout(() => timeoutCtl?.abort(), timeoutMs);
    const signal = req.signal && timeoutCtl
      ? AbortSignal.any([req.signal, timeoutCtl.signal])
      : (req.signal ?? timeoutCtl?.signal);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey() ? { authorization: `Bearer ${apiKey()}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (req.signal?.aborted) throw new LlmError("Appel LLM annulé.", "ABORTED");
      if (timeoutCtl?.signal.aborted) {
        throw new LlmError(`Le endpoint LLM a mis trop de temps (timeout ${timeoutMs} ms).`, "TIMEOUT", true);
      }
      // Erreur réseau AVANT envoi (DNS, connexion refusée…) → retryable, rien facturé.
      throw new LlmError(`Endpoint LLM injoignable (${e instanceof Error ? e.message : e})`, "NETWORK", true);
    }
    clearTimeout(timer);

    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      // UPSTREAM : le endpoint a refusé avant de traiter (4xx/5xx) — rien facturé.
      const code = res.status === 401 || res.status === 403 ? "AUTH" : res.status === 429 ? "RATE_LIMIT" : "UPSTREAM";
      throw new LlmError(
        `Endpoint LLM : HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
        code,
        retryableStatus(res.status)
      );
    }

    const json = (await res.json().catch(() => null)) as ChatCompletionResponse | null;
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new LlmError("Réponse du endpoint LLM illisible (choices[0].message.content attendu).");
    }
    return {
      text,
      usage: {
        inputTokens: json?.usage?.prompt_tokens,
        outputTokens: json?.usage?.completion_tokens,
      },
      provider: this.name,
      model,
    };
  },
};
