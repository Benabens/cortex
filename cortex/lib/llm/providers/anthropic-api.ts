import Anthropic from "@anthropic-ai/sdk";
import { apiKey, baseUrl, mapModel } from "../config";
import { LlmError, type CompleteRequest, type CompleteResult, type LlmProvider, type LlmUsage } from "../types";

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

/** Mots-clés que la sortie structurée n'accepte pas : retirés (le site d'appel valide lui-même). */
const UNSUPPORTED_KEYWORDS = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties",
]);

/**
 * Copie du schéma acceptable par la sortie structurée (output_config.format) :
 * `additionalProperties: false` sur chaque objet, contraintes non prises en
 * charge retirées. null si un objet est libre (sans propriétés, ou ouvert) :
 * aucun schéma strict ne l'exprime, l'appel part alors en texte libre.
 */
export function structuredSchema(schema: object): object | null {
  let ok = true;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (UNSUPPORTED_KEYWORDS.has(k)) continue;
      if (k === "properties" || k === "$defs" || k === "definitions") {
        out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([name, sub]) => [name, walk(sub)]));
      } else if (k === "items" || k === "anyOf" || k === "allOf" || k === "oneOf") {
        out[k] = walk(v);
      } else {
        out[k] = v;
      }
    }
    const types = Array.isArray(src.type) ? src.type : [src.type];
    if (types.includes("object")) {
      if (!src.properties || (src.additionalProperties !== undefined && src.additionalProperties !== false)) ok = false;
      out.additionalProperties = false;
    }
    return out;
  };
  const strict = walk(schema);
  return ok ? (strict as object) : null;
}

function toLlmError(e: unknown): LlmError {
  const err = e as { status?: number; message?: string; name?: string };
  const msg = err?.message ? String(err.message) : String(e);
  if (err?.name === "AbortError") return new LlmError("Appel LLM annulé.", "ABORTED");
  const status = typeof err?.status === "number" ? err.status : undefined;
  if (status === 401 || status === 403) return new LlmError(msg, "AUTH");
  if (status === 429) return new LlmError(msg, "RATE_LIMIT", true);
  if (status === 529) return new LlmError(msg, "OVERLOADED", true);
  if (retryableStatus(status)) return new LlmError(msg, "UPSTREAM", true); // 5xx : refus avant traitement
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
    // CACHE DE PROMPT : le prompt système, s'il existe, est le préfixe STABLE
    // d'une famille d'appels → on le marque cacheable (lecture ultérieure à
    // 0,1×). N'a d'effet que si ce préfixe atteint le seuil du modèle
    // (1 024 tokens pour Sonnet 5 / Opus 4.8). N'altère PAS la chaîne de prompt
    // hashée par la régression cs-202 (c'est un paramètre de requête, pas le
    // texte) → invariant byte-identique intact. NB : réordonner le
    // prompt d'examen POUR franchir le seuil casserait cet invariant (non fait).
    if (req.system) {
      params.system = [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }];
    }
    if (req.thinking === "adaptive") params.thinking = { type: "adaptive" };
    // SORTIE STRUCTURÉE : la réponse est garantie conforme au schéma (plus de JSON
    // illisible). Schéma inexprimable → texte libre, lu par extractJson.
    const strict = req.json ? structuredSchema(req.json.schema) : null;
    const outputConfig = {
      ...(strict ? { format: { type: "json_schema", schema: strict } } : {}),
      ...(req.json?.effort ? { effort: req.json.effort } : {}),
    };
    if (Object.keys(outputConfig).length) params.output_config = outputConfig;

    const run = async (p: Record<string, unknown>) => {
      const stream = client(key).messages.stream(
        p as Parameters<Anthropic["messages"]["stream"]>[0],
        { ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}), ...(req.signal ? { signal: req.signal } : {}) }
      );
      return stream.finalMessage();
    };

    let msg: Awaited<ReturnType<typeof run>>;
    try {
      try {
        msg = await run(params);
      } catch (e) {
        // Un schéma refusé par l'API (400) ne doit pas faire échouer la génération :
        // un seul rejeu en texte libre, sans le format (l'effort est gardé).
        if ((e as { status?: number })?.status !== 400 || !strict) throw e;
        console.error(`[llm] anthropic : sortie structurée refusée (${(e as Error).message.slice(0, 160)}) — rejeu en texte libre`);
        const rest = { ...outputConfig } as Record<string, unknown>;
        delete rest.format;
        const fallback = { ...params };
        if (Object.keys(rest).length) fallback.output_config = rest;
        else delete fallback.output_config;
        msg = await run(fallback);
      }
    } catch (e) {
      throw toLlmError(e);
    }

    const textBlock = msg.content.find((b) => b.type === "text") as { text?: string } | undefined;
    // `usage` de l'API = comptes EXACTS (jamais estimés). cache_* renseignés dès
    // qu'un `cache_control` est envoyé (mesure du cache de prompt).
    const u = msg.usage as
      | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
      | undefined;
    const usage: LlmUsage = {
      inputTokens: u?.input_tokens ?? undefined,
      outputTokens: u?.output_tokens ?? undefined,
    };
    // Champs cache : présents seulement quand l'API les renvoie (cache_control envoyé).
    if (u?.cache_read_input_tokens != null) usage.cacheReadTokens = u.cache_read_input_tokens;
    if (u?.cache_creation_input_tokens != null) usage.cacheWriteTokens = u.cache_creation_input_tokens;
    // Une réponse COUPÉE ou REFUSÉE n'est jamais rendue comme un texte valide :
    // elle passerait à extractJson, qui ne doit pas la prendre pour une réponse complète.
    if (msg.stop_reason === "max_tokens") {
      throw new LlmError(`Réponse du modèle coupée par la limite de longueur (${req.maxTokens ?? 16_000} tokens).`, "TRUNCATED", false, usage);
    }
    if (msg.stop_reason === "refusal") {
      throw new LlmError("Le modèle a refusé de traiter cette demande.", "REFUSAL", false, usage);
    }
    return { text: textBlock?.text ?? "", usage, provider: this.name, model };
  },
};
