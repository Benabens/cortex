import { isGuardedDeployment } from "@/lib/boot-guards";
import { currentCourse } from "@/db/client";
import { currentUser } from "@/db/context";
import { authAll, authInsert, authRun } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { log } from "@/lib/metrics";
import { LlmError } from "@/lib/llm/types";
import { guardsActive, floatLimit } from "./env";
import { ownerAlertBlocker } from "./owner-alert";
import { alertSpendThresholds, resetSpendAlerts } from "./spend-alerts";

/**
 * COMPTAGE DE COÛT + KILL-SWITCH.
 *
 * Chaque appel LLM d'un provider PAYANT (anthropic / openai-compatible) est
 * loggé dans la table GLOBALE `llm_usage` (store auth : data/auth.db en
 * sqlite, schéma public en Postgres — cross-tenant, survit aux redémarrages)
 * avec son coût estimé (tokens × tarif du modèle).
 *
 * SPEND_CAP_USD : plafond de dépense GLOBAL du MOIS CALENDAIRE en cours (UTC),
 * remis à zéro le 1er. Atteint → tout nouvel appel payant est refusé par une
 * LlmError code "SPEND_CAP" (message clair, jamais un 502 générique) ; le
 * provider claude-code (dev €0 via le CLI local) n'est JAMAIS bloqué ni compté
 * (comportement historique intact).
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
// Inconnu → le tarif LE PLUS CHER de la grille (jamais sous-compté), signalé une fois par modèle.
const FALLBACK_RATE = PRICING.reduce((a, b) => (b.outPerM > a.outPerM ? b : a));
const unknownRateWarned = new Set<string>();

export function rateFor(model: string): { inPerM: number; outPerM: number; cacheReadPerM: number; cacheWritePerM: number } {
  const hit = PRICING.find((p) => model.startsWith(p.prefix));
  if (hit) return hit;
  if (!unknownRateWarned.has(model)) {
    unknownRateWarned.add(model);
    log("warn", "usage.unknown_model_rate", { model, appliedPrefix: FALLBACK_RATE.prefix, pricingDate: PRICING_DATE });
  }
  return FALLBACK_RATE;
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

export type UsageEstimate = {
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  callSite?: string | null;
  jobId?: string | null;
  attempt?: number;
};

/**
 * COMPTAGE EN VOL. Un appel payant est écrit DÈS SON DÉPART comme ligne
 * estimée (entrée ≈ taille du prompt, sortie = max_tokens), puis finalisée en
 * place au retour (`closeUsage`) ou retirée si le fournisseur n'a rien traité
 * (`discardUsage`, refus 4xx/5xx avant exécution). Un worker tué en plein
 * appel — annulation, crash — laisse donc une trace de coût : le remboursement
 * conditionné au coût réel ne se contourne pas en annulant pendant le premier
 * appel, et le plafond voit les appels en cours. Renvoie null quand rien
 * n'est compté (provider gratuit hors suivi, store indisponible).
 */
export async function openUsage(u: UsageEstimate): Promise<number | null> {
  const paid = isPaidProvider(u.provider);
  if (!paid && !usageTrackingActive()) return null;
  try {
    const rate = paid ? rateFor(u.model) : { inPerM: 0, outPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 };
    const cost = paid ? estimateCostUsd(u.model, u.tokensIn, u.tokensOut) : 0;
    const id = await authInsert(
      `INSERT INTO llm_usage
         (user_id, course, provider, model, tokens_in, tokens_out, cost_usd, rate_in_per_m, rate_out_per_m, estimated, job_id, call_site, attempt, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      currentUser(), currentCourse(), u.provider, u.model, u.tokensIn, u.tokensOut,
      cost, rate.inPerM, rate.outPerM, 1, u.jobId ?? null, u.callSite ?? null, u.attempt ?? null, nowStr(),
    );
    _spendCache = null;
    return id || null;
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 200) : String(e);
    // FAIL-CLOSED en déploiement gardé : sans trace écrite AVANT l'envoi, la
    // dépense échapperait au plafond et au compte de l'utilisateur → l'appel
    // payant ne part pas (503 côté route). En dev, on laisse passer.
    if (paid && isGuardedDeployment()) {
      log("error", "usage.open_failed_closed", { message });
      throw new LlmError("Comptage des coûts indisponible : appel au modèle refusé. Réessaie dans un instant.", "UNAVAILABLE");
    }
    log("warn", "usage.open_failed", { message });
    return null;
  }
}

/** Finalise la ligne provisoire avec les compteurs réels (provider payant → estimated=0). */
export async function closeUsage(id: number | null, u: {
  provider: string; model: string; tokensIn?: number; tokensOut?: number; cacheRead?: number; cacheWrite?: number; latencyMs?: number;
}): Promise<void> {
  if (id === null) return;
  const paid = isPaidProvider(u.provider);
  try {
    const rate = paid ? rateFor(u.model) : { inPerM: 0, outPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 };
    const cost = paid ? estimateCostUsd(u.model, u.tokensIn, u.tokensOut, u.cacheRead, u.cacheWrite) : 0;
    await authRun(
      `UPDATE llm_usage SET provider = ?, model = ?, tokens_in = ?, tokens_out = ?, cache_read = ?, cache_write = ?,
         cost_usd = ?, rate_in_per_m = ?, rate_out_per_m = ?, estimated = ?, latency_ms = ? WHERE id = ?`,
      u.provider, u.model, u.tokensIn ?? null, u.tokensOut ?? null, u.cacheRead ?? null, u.cacheWrite ?? null,
      cost, rate.inPerM, rate.outPerM, paid ? 0 : 1, u.latencyMs ?? null, id,
    );
    _spendCache = null;
  } catch (e) {
    log("warn", "usage.close_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
  }
  // La dépense vient de bouger : c'est ici qu'un seuil se franchit.
  if (paid) await alertOnSpend();
}

/** Retire la ligne provisoire : le fournisseur a refusé avant de traiter (rien facturé). */
export async function discardUsage(id: number | null): Promise<void> {
  if (id === null) return;
  try {
    await authRun(`DELETE FROM llm_usage WHERE id = ? AND estimated = 1`, id);
    _spendCache = null;
  } catch (e) {
    log("warn", "usage.discard_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
  }
}

/** Mois calendaire UTC en cours, « AAAA-MM » (`created_at` est écrit en UTC par nowStr). */
export function spendMonth(): string {
  return nowStr().slice(0, 7);
}

/** Une dépense et le mois qu'elle couvre voyagent ensemble : à minuit le 1er,
 *  une somme demandée la veille ne doit pas être annoncée comme celle du mois neuf. */
type MonthSpend = { month: string; total: number };

/** Dépense globale du mois en cours (USD), lue en DB, sans cache. */
async function readMonthSpend(): Promise<MonthSpend> {
  const month = spendMonth();
  const rows = await authAll<{ total: number | string | null }>(
    `SELECT coalesce(sum(cost_usd), 0) AS total FROM llm_usage WHERE substr(created_at, 1, 7) = ?`, month,
  );
  return { month, total: Number(rows[0]?.total ?? 0) };
}

/** La même, avec un cache in-process de 30 s. Le cache porte son mois : au
 *  passage du 1er, il ne sert pas le total de la veille. */
let _spendCache: ({ at: number } & MonthSpend) | null = null;
async function cachedMonthSpend(): Promise<MonthSpend> {
  if (_spendCache && _spendCache.month === spendMonth() && Date.now() - _spendCache.at < 30_000) return _spendCache;
  const fresh = await readMonthSpend();
  _spendCache = { at: Date.now(), ...fresh };
  return fresh;
}
export async function monthSpendUsd(): Promise<number> {
  return (await cachedMonthSpend()).total;
}

/** (tests) vide le cache du plafond et la mémoire des alertes : l'état d'un process neuf. */
export function resetSpendCache(): void {
  _spendCache = null;
  resetSpendAlerts();
}

/**
 * Alertes de seuil sur la dépense du mois (lib/billing/spend-alerts). Ne lève
 * JAMAIS : une alerte ratée ne doit ni refuser ni casser un appel au modèle.
 * Sans plafond (dev, « unlimited ») il n'y a pas de seuil ; `0` est un
 * kill-switch posé à la main, pas un franchissement.
 */
async function alertOnSpend(known?: MonthSpend): Promise<void> {
  try {
    const cap = spendCapUsd();
    if (cap === null || cap <= 0) return;
    // Lecture SANS cache : le total relu ici, en fin d'appel, ne doit pas servir
    // de réponse au plafond pendant 30 s alors qu'un autre process dépense.
    const spend = known ?? (await readMonthSpend());
    await alertSpendThresholds(spend.total, cap, spend.month);
  } catch (e) {
    log("warn", "spend_alert.failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
  }
}

/**
 * Au démarrage du serveur : un plafond actif dont les alertes ne peuvent pas
 * partir se dit une fois, là où les logs sont lus (la sortie des workers de
 * jobs n'est pas conservée).
 */
export function warnIfSpendAlertsBlocked(): void {
  const cap = spendCapUsd();
  if (cap === null || cap <= 0) return;
  const reason = ownerAlertBlocker();
  if (reason) log("warn", "spend_alert.disabled", { cap, reason, message: `Alertes de dépense à 80 % et 100 % inactives (${reason}).` });
}

/**
 * Plafond de dépense GLOBAL par mois calendaire (USD). FAIL-CLOSED : dans un
 * déploiement gardé (auth ou facturation), 50 $ par défaut si la variable est
 * oubliée — un plafond global absent transformait un oubli de config en dépense
 * sans borne. `unlimited` lève explicitement ; `0` reste le kill-switch
 * d'urgence total.
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
 * KILL-SWITCH : refuse l'appel payant si le plafond GLOBAL du mois ou le
 * plafond PAR UTILISATEUR/JOUR est atteint. Ne concerne que les providers payants
 * (claude-code = €0, jamais bloqué). Message clair (code SPEND_CAP), jamais 502.
 */
export async function assertSpendCap(provider: string): Promise<void> {
  if (!isPaidProvider(provider)) return;
  try {
    await assertSpendCapUnchecked();
  } catch (e) {
    if (e instanceof LlmError) throw e;
    // Base injoignable : un plafond INVÉRIFIABLE vaut plafond atteint en
    // déploiement gardé (l'appel payant ne part pas) ; en dev, on laisse passer.
    const message = e instanceof Error ? e.message.slice(0, 200) : String(e);
    if (isGuardedDeployment()) {
      log("error", "spend_cap.check_failed_closed", { message });
      throw new LlmError("Plafond de dépense invérifiable (base indisponible) : appel au modèle refusé. Réessaie dans un instant.", "UNAVAILABLE");
    }
    log("warn", "spend_cap.check_failed", { message });
  }
}

async function assertSpendCapUnchecked(): Promise<void> {
  const globalCap = spendCapUsd();
  if (globalCap !== null) {
    const spend = await cachedMonthSpend();
    const spent = spend.total;
    await alertOnSpend(spend);
    if (spent >= globalCap) {
      throw new LlmError(
        `Plafond de dépense global du mois atteint (${spent.toFixed(2)} $ ≥ SPEND_CAP_USD=${globalCap} $ pour ${spend.month}) — génération coupée. ` +
        `Le reste du site fonctionne ; elle rouvre le 1er du mois prochain (UTC), ou dès que SPEND_CAP_USD est relevé.`,
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
