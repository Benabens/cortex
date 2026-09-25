import { currentCourse } from "@/db/client";
import { currentUser } from "@/db/context";
import { authAll, authRun } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { log } from "@/lib/metrics";
import { LlmError } from "@/lib/llm/types";
import { guardsActive, floatLimit } from "./env";

/**
 * COMPTAGE DE COÛT + KILL-SWITCH.
 *
 * Chaque appel LLM d'un provider PAYANT (anthropic / openai-compatible) est
 * loggé dans la table GLOBALE `llm_usage` (store auth : data/auth.db en
 * sqlite, schéma public en Postgres — cross-tenant, survit aux redémarrages)
 * avec son coût estimé (tokens × tarif du modèle).
 *
 * SPEND_CAP_USD : plafond de dépense GLOBAL. Atteint → tout nouvel appel
 * payant est refusé par une LlmError code "SPEND_CAP" (message clair, jamais
 * un 502 générique) ; le provider claude-code (dev €0 via le CLI local) n'est JAMAIS
 * bloqué ni compté (comportement historique intact).
 */

/** Tarifs USD par MTok {in, out, lecture cache, écriture cache} — préfixe d'id
 *  de modèle → tarif. Source : platform.claude.com/docs pricing, vérifié le
 *  18/09/2026 (⚠ le tarif Sonnet 5 était faux, 3/15 → corrigé à 2/10). Ordre =
 *  du plus spécifique au moins spécifique ; inconnu → tarif opus (on SURestime).
 *  cache : lecture 0,1× de l'entrée, écriture 5 min 1,25× de l'entrée. */
const PRICING_DATE = "2026-09-18";
const PRICING: Array<{ prefix: string; inPerM: number; outPerM: number; cacheReadPerM: number; cacheWritePerM: number }> = [
  { prefix: "claude-fable", inPerM: 10, outPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5 },
  { prefix: "claude-mythos", inPerM: 10, outPerM: 50, cacheReadPerM: 1, cacheWritePerM: 12.5 },
  { prefix: "claude-opus", inPerM: 5, outPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 },
  { prefix: "claude-sonnet", inPerM: 2, outPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 },
  { prefix: "claude-haiku", inPerM: 1, outPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },
];
const FALLBACK_RATE = { inPerM: 5, outPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 }; // inconnu → tarif opus

export function rateFor(model: string): { inPerM: number; outPerM: number; cacheReadPerM: number; cacheWritePerM: number } {
  return PRICING.find((p) => model.startsWith(p.prefix)) ?? FALLBACK_RATE;
}

/** Coût USD d'un appel, cache compris. Entrées « pleines » facturées au tarif
 *  d'entrée, lectures/écritures de cache à leur tarif dédié. */
export function estimateCostUsd(
  model: string,
  tokensIn?: number,
  tokensOut?: number,
  cacheRead?: number,
  cacheWrite?: number,
): number {
  const r = rateFor(model);
  return (
    ((tokensIn ?? 0) / 1_000_000) * r.inPerM +
    ((tokensOut ?? 0) / 1_000_000) * r.outPerM +
    ((cacheRead ?? 0) / 1_000_000) * r.cacheReadPerM +
    ((cacheWrite ?? 0) / 1_000_000) * r.cacheWritePerM
  );
}

/** Les providers dont les appels coûtent de l'argent réel. */
export function isPaidProvider(provider: string): boolean {
  return provider !== "claude-code";
}

/**
 * Le comptage d'usage est-il actif ? On écrit `llm_usage` dans toute vraie
 * déploiement (AUTH ou BILLING) — pour MESURER, y compris le provider gratuit
 * claude-code — mais JAMAIS en dev €0 nu (aucune variable → aucun fichier créé,
 * invariant n°1). Opt-in local possible via CORTEX_TRACK_USAGE=1.
 */
export function usageTrackingActive(): boolean {
  return guardsActive() || process.env.CORTEX_TRACK_USAGE === "1";
}

/** Enregistre un appel (best-effort : ne casse JAMAIS l'appel LLM). */
export async function recordUsage(u: {
  provider: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  cacheWrite?: number;
  latencyMs?: number;
  callSite?: string | null;
  jobId?: string | null;
  attempt?: number;
  /** Appel échoué après envoi : tokens ESTIMÉS (le fournisseur a facturé, pas de compteur retourné). */
  estimated?: boolean;
}): Promise<void> {
  const paid = isPaidProvider(u.provider);
  // Un appel PAYANT coûte de l'argent réel → toujours loggé (même en dev, si
  // quelqu'un configure explicitement un provider API). Le provider GRATUIT
  // (claude-code) n'est loggé qu'en déploiement gardé ou opt-in — sinon le dev
  // €0 nu créerait un store (invariant n°1).
  if (!paid && !usageTrackingActive()) return;
  try {
    // Provider gratuit (claude-code, CLI local) : coût marginal 0, mais on garde
    // les tokens rapportés par le CLI et on marque la ligne estimated=1 (le
    // compte inclut le prompt système de la CLI, non attribuable à l'unité).
    const rate = paid ? rateFor(u.model) : { inPerM: 0, outPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 };
    const cost = paid ? estimateCostUsd(u.model, u.tokensIn, u.tokensOut, u.cacheRead, u.cacheWrite) : 0;
    await authRun(
      `INSERT INTO llm_usage
         (user_id, course, provider, model, tokens_in, tokens_out, cache_read, cache_write,
          cost_usd, rate_in_per_m, rate_out_per_m, estimated, job_id, call_site, attempt, latency_ms, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      currentUser(), currentCourse(), u.provider, u.model,
      u.tokensIn ?? null, u.tokensOut ?? null, u.cacheRead ?? null, u.cacheWrite ?? null,
      cost, rate.inPerM, rate.outPerM, paid && !u.estimated ? 0 : 1,
      u.jobId ?? null, u.callSite ?? null, u.attempt ?? null, u.latencyMs ?? null, nowStr(),
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

/**
 * Plafond de dépense GLOBAL (USD). FAIL-CLOSED : dans un déploiement gardé
 * (auth ou facturation), 50 $ par défaut si la variable est oubliée — un
 * plafond global absent transformait un oubli de config en dépense sans borne.
 * `unlimited` lève explicitement ; `0` reste le kill-switch d'urgence total.
 */
export function spendCapUsd(): number | null {
  return floatLimit("SPEND_CAP_USD", 50);
}

/**
 * Plafond de dépense PAR UTILISATEUR et PAR JOUR (USD). FAIL-CLOSED : dans un
 * déploiement gardé, un défaut s'applique même sans variable — un plafond
 * GLOBAL seul transformerait un abuseur en déni de service pour tous les autres
 * (l'audit). Défaut 15 $/user/jour : très au-dessus de l'usage réel le plus
 * lourd mesuré (~6,6 $/jour), backstop d'une boucle emballée.
 */
export function spendCapPerUserUsd(): number | null {
  return floatLimit("SPEND_CAP_PER_USER_USD", 15);
}

/** Dépense d'un utilisateur AUJOURD'HUI (USD) — fenêtre glissante = la journée
 *  courante, comme les quotas (`day = created_at[0:10]`). */
export async function spentTodayByUser(userId = currentUser()): Promise<number> {
  const day = nowStr().slice(0, 10);
  const rows = await authAll<{ total: number | string | null }>(
    `SELECT coalesce(sum(cost_usd), 0) AS total FROM llm_usage WHERE user_id = ? AND substr(created_at, 1, 10) = ?`,
    userId, day,
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * KILL-SWITCH : refuse l'appel payant si le plafond GLOBAL ou le plafond
 * PAR UTILISATEUR/JOUR est atteint. Ne concerne que les providers payants
 * (claude-code = €0, jamais bloqué). Message clair (code SPEND_CAP), jamais 502.
 */
export async function assertSpendCap(provider: string): Promise<void> {
  if (!isPaidProvider(provider)) return;

  const globalCap = spendCapUsd();
  if (globalCap !== null) {
    const spent = await totalSpendUsd();
    if (spent >= globalCap) {
      throw new LlmError(
        `Plafond de dépense global atteint (${spent.toFixed(2)} $ ≥ SPEND_CAP_USD=${globalCap} $) — génération coupée. ` +
        `Le reste du site fonctionne ; augmente SPEND_CAP_USD pour ré-ouvrir.`,
        "SPEND_CAP",
        false,
      );
    }
  }

  const perUserCap = spendCapPerUserUsd();
  if (perUserCap !== null) {
    const spentUser = await spentTodayByUser();
    if (spentUser >= perUserCap) {
      throw new LlmError(
        `Plafond de dépense quotidien atteint pour ce compte (${spentUser.toFixed(2)} $ ≥ ${perUserCap} $/jour). ` +
        `Réessaie demain, ou augmente SPEND_CAP_PER_USER_USD.`,
        "SPEND_CAP",
        false,
      );
    }
  }
}

/** Récap de dépense par user (pour /api/billing / observabilité). */
export async function spendByUser(limit = 50): Promise<Array<{ user_id: string; total: number; calls: number }>> {
  return (await authAll<{ user_id: string; total: number; calls: number }>(
    `SELECT user_id, coalesce(sum(cost_usd),0) AS total, count(*) AS calls
     FROM llm_usage GROUP BY user_id ORDER BY total DESC LIMIT ?`, limit,
  )).map((r) => ({ ...r, total: Number(r.total), calls: Number(r.calls) }));
}
