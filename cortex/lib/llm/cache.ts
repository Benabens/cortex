import crypto from "node:crypto";
import { q } from "@/db/q";
import type { CompleteRequest, CompleteResult } from "./types";

/**
 * CACHE LLM par HASH DE CONTENU (Phase E) — dédup des appels identiques
 * (prompt + modèle + params). Gros gain latence/coût sur les lots répétés et
 * les relectures vision. OPT-IN par CACHE_ENABLED=1 (défaut : désactivé →
 * comportement historique strictement inchangé).
 *
 * Backing : table `llm_cache` dans la DB du cours/tenant courant (portable
 * sqlite/postgres via la façade q) — pas de Redis requis. Le provider `text` et
 * son `usage` sont mémorisés ; un hit renvoie le texte SANS rappeler le modèle.
 *
 * SÛRETÉ : on NE met en cache QUE les réponses déterministes-compatibles —
 * exclut les appels avec `signal` (annulables) et `addDirs` (vision par fichiers
 * dont le contenu disque peut changer sans changer le prompt → risque de hit
 * périmé). Les sorties LLM ne sont pas déterministes, mais pour Cortex un même
 * prompt de génération redonne une variante équivalente : le cache est un choix
 * de coût explicite de l'utilisateur, pas une garantie de reproductibilité.
 */

export function cacheEnabled(): boolean {
  return process.env.CACHE_ENABLED === "1";
}

/** Clé de contenu stable : tout ce qui influence la sortie, sérialisé canoniquement. */
export function cacheKey(providerName: string, req: CompleteRequest): string {
  const material = JSON.stringify({
    p: providerName,
    prompt: req.prompt,
    system: req.system ?? null,
    model: req.model ?? "opus",
    maxTokens: req.maxTokens ?? null,
    json: req.json ? { schema: req.json.schema, effort: req.json.effort ?? null } : null,
    thinking: req.thinking ?? null,
    images: (req.images ?? []).map((i) => `${i.mediaType}:${crypto.createHash("sha256").update(i.base64).digest("hex")}`),
  });
  return crypto.createHash("sha256").update(material).digest("hex");
}

/** Un appel est-il cachable ? (exclut annulables et vision-par-fichiers). */
export function cacheable(req: CompleteRequest): boolean {
  return cacheEnabled() && !req.signal && !(req.addDirs && req.addDirs.length);
}

let _ready = false;
async function ensure(): Promise<void> {
  if (_ready) return;
  await q.ensureTable("llm_cache");
  _ready = true;
}

export async function cacheGet(key: string): Promise<CompleteResult | null> {
  try {
    await ensure();
    const row = await q.get<{ text: string; provider: string; model: string; input_tokens: number | null; output_tokens: number | null }>(
      `SELECT text, provider, model, input_tokens, output_tokens FROM llm_cache WHERE key = ?`,
      key,
    );
    if (!row) return null;
    await q.run(`UPDATE llm_cache SET hits = hits + 1 WHERE key = ?`, key);
    return {
      text: row.text,
      provider: row.provider,
      model: row.model,
      usage: { inputTokens: row.input_tokens ?? undefined, outputTokens: row.output_tokens ?? undefined },
    };
  } catch {
    return null; // cache best-effort : jamais bloquant
  }
}

export async function cachePut(key: string, res: CompleteResult): Promise<void> {
  try {
    await ensure();
    await q.run(
      `INSERT INTO llm_cache (key, provider, model, text, input_tokens, output_tokens)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET text = excluded.text, provider = excluded.provider, model = excluded.model,
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens`,
      key, res.provider, res.model, res.text, res.usage?.inputTokens ?? null, res.usage?.outputTokens ?? null,
    );
  } catch { /* best-effort */ }
}
