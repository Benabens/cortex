import { currentCourse } from "@/db/client";
import { currentUser } from "@/db/context";
import { authAll, authRun } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { log } from "@/lib/metrics";
import { LlmError } from "@/lib/llm/types";

/**
 * COMPTAGE DE COÛT + KILL-SWITCH (déploiement v1 — RÈGLE D'OR n°2).
 *
 * Chaque appel LLM d'un provider PAYANT (anthropic / openai-compatible) est
 * loggé dans la table GLOBALE `llm_usage` (store auth : data/auth.db en
 * sqlite, schéma public en Postgres — cross-tenant, survit aux redémarrages)
 * avec son coût estimé (tokens × tarif du modèle).
 *
 * SPEND_CAP_USD : plafond de dépense GLOBAL. Atteint → tout nouvel appel
 * payant est refusé par une LlmError code "SPEND_CAP" (message clair, jamais
 * un 502 générique) ; le provider claude-code (dev €0 via Max) n'est JAMAIS
 * bloqué ni compté (comportement historique intact).
 */

/** Tarifs USD par MTok {in, out} — préfixe d'id de modèle → tarif.
 *  Source : doc officielle Anthropic (07/2026). Ordre = du plus spécifique au
 *  moins spécifique ; inconnu → tarif opus (conservateur, on SURestime). */
const PRICING: Array<{ prefix: string; inPerM: number; outPerM: number }> = [
  { prefix: "claude-fable", inPerM: 10, outPerM: 50 },
  { prefix: "claude-mythos", inPerM: 10, outPerM: 50 },
  { prefix: "claude-opus", inPerM: 5, outPerM: 25 },
  { prefix: "claude-sonnet", inPerM: 3, outPerM: 15 },
  { prefix: "claude-haiku", inPerM: 1, outPerM: 5 },
];
const FALLBACK_RATE = { inPerM: 5, outPerM: 25 }; // inconnu → tarif opus

export function estimateCostUsd(model: string, tokensIn?: number, tokensOut?: number): number {
  const rate = PRICING.find((p) => model.startsWith(p.prefix)) ?? FALLBACK_RATE;
  const cin = ((tokensIn ?? 0) / 1_000_000) * rate.inPerM;
  const cout = ((tokensOut ?? 0) / 1_000_000) * rate.outPerM;
  return cin + cout;
}

/** Les providers dont les appels coûtent de l'argent réel. */
function isPaidProvider(provider: string): boolean {
  return provider !== "claude-code";
}

/** Enregistre un appel (best-effort : ne casse JAMAIS l'appel LLM). */
export async function recordUsage(u: {
  provider: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
}): Promise<void> {
  // claude-code = €0 : pas de ligne (sauf opt-in de télémétrie CORTEX_TRACK_USAGE=1).
  if (!isPaidProvider(u.provider) && process.env.CORTEX_TRACK_USAGE !== "1") return;
  try {
    const cost = isPaidProvider(u.provider) ? estimateCostUsd(u.model, u.tokensIn, u.tokensOut) : 0;
    await authRun(
      `INSERT INTO llm_usage (user_id, course, provider, model, tokens_in, tokens_out, cost_usd, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      currentUser(), currentCourse(), u.provider, u.model,
      u.tokensIn ?? null, u.tokensOut ?? null, cost, nowStr(),
    );
    _spendCache = null; // la dépense a bougé → invalide le cache du kill-switch
  } catch (e) {
    log("warn", "usage.record_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
  }
}

/** Dépense cumulée globale (USD), lue en DB (cache in-process 30 s). */
let _spendCache: { at: number; total: number } | null = null;
export async function totalSpendUsd(): Promise<number> {
  if (_spendCache && Date.now() - _spendCache.at < 30_000) return _spendCache.total;
  const rows = await authAll<{ total: number | string | null }>(
    `SELECT coalesce(sum(cost_usd), 0) AS total FROM llm_usage`
  );
  const total = Number(rows[0]?.total ?? 0);
  _spendCache = { at: Date.now(), total };
  return total;
}

/** (tests) vide le cache du plafond. */
export function resetSpendCache(): void {
  _spendCache = null;
}

export function spendCapUsd(): number | null {
  const raw = process.env.SPEND_CAP_USD;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * KILL-SWITCH : refuse l'appel si le plafond global est atteint.
 * Ne concerne que les providers payants ; sans SPEND_CAP_USD → no-op.
 */
export async function assertSpendCap(provider: string): Promise<void> {
  if (!isPaidProvider(provider)) return;
  const cap = spendCapUsd();
  if (cap === null) return;
  const spent = await totalSpendUsd();
  if (spent >= cap) {
    throw new LlmError(
      `Plafond de dépense atteint (${spent.toFixed(2)} $ ≥ SPEND_CAP_USD=${cap} $) — génération coupée. ` +
      `Le reste du site fonctionne ; augmente SPEND_CAP_USD pour ré-ouvrir.`,
      "SPEND_CAP",
      false,
    );
  }
}

/** Récap de dépense par user (pour /api/billing / observabilité). */
export async function spendByUser(limit = 50): Promise<Array<{ user_id: string; total: number; calls: number }>> {
  return (await authAll<{ user_id: string; total: number; calls: number }>(
    `SELECT user_id, coalesce(sum(cost_usd),0) AS total, count(*) AS calls
     FROM llm_usage GROUP BY user_id ORDER BY total DESC LIMIT ?`, limit,
  )).map((r) => ({ ...r, total: Number(r.total), calls: Number(r.calls) }));
}
