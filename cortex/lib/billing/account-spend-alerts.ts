import { authAll } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { claimOnce, settleClaim } from "@/lib/claim-once";
import { log } from "@/lib/metrics";
import { captureError, flushErrorTracking } from "@/lib/observability";
import { floatLimit } from "./env";
import { isOwner } from "./owner";

/**
 * ALERTE DE DÉPENSE PAR COMPTE ET PAR HEURE (audit fuites P7) : un événement Sentry
 * quand un compte dépense plus de SPEND_ALERT_PER_USER_HOUR_USD (défaut 5 $) dans
 * l'heure UTC en cours. Le fusible du jour (SPEND_CAP_PER_USER_USD, 15 $) coupe ;
 * cette alerte prévient avant, pendant qu'une boucle emballée ou un abus se voit
 * encore : l'usage réel le plus lourd mesuré tient en ≈ 6,6 $ sur une JOURNÉE.
 * Le seuil ne dépasse jamais le fusible du jour (sinon il ne préviendrait de rien).
 *
 * Une fois par compte et par heure, même avec plusieurs process (serveur, un worker
 * par job) : la clé est réclamée dans `app_meta` (lib/claim-once). Pas de reprise :
 * une alerte perdue (Sentry éteint, process tué) n'est pas renvoyée, l'heure
 * suivante réarme. Le propriétaire n'est pas suivi : il est exempté du fusible.
 *
 * Rien qui identifie le compte ne part chez Sentry (lib/observability) : le compte,
 * les montants et l'heure sont dans le journal `spend_alert.account_hour`, que
 * l'événement Sentry cite. Ne lève jamais : une alerte ratée ne doit pas casser
 * l'appel au modèle qui vient d'aboutir.
 */

/** Ce que ce process sait déjà signalé (ou réclamé ailleurs) : plus aucune requête pour ces clés. */
const known = new Set<string>();

/** (tests) oublie ce que ce process sait, comme au démarrage. */
export function resetAccountSpendAlerts(): void {
  known.clear();
}

/** Seuil horaire effectif (USD) ; null = alerte coupée (`unlimited`, ou hors déploiement gardé). */
export function accountHourAlertUsd(): number | null {
  const threshold = floatLimit("SPEND_ALERT_PER_USER_HOUR_USD", 5);
  if (threshold === null || threshold <= 0) return null;
  const dayCap = floatLimit("SPEND_CAP_PER_USER_USD", 15);
  return dayCap !== null && dayCap > 0 ? Math.min(threshold, dayCap) : threshold;
}

/** Dépense d'un compte dans l'heure UTC `hour` (« AAAA-MM-JJ HH »). */
async function spentInHour(userId: string, hour: string): Promise<number> {
  const rows = await authAll<{ total: number | string | null }>(
    `SELECT coalesce(sum(cost_usd), 0) AS total FROM llm_usage WHERE user_id = ? AND substr(created_at, 1, 13) = ?`,
    userId, hour,
  );
  return Number(rows[0]?.total ?? 0);
}

/** À appeler après chaque dépense payante enregistrée pour `userId`. */
export async function alertAccountHourSpend(userId: string): Promise<void> {
  try {
    const threshold = accountHourAlertUsd();
    if (threshold === null) return;
    const hour = nowStr().slice(0, 13);
    const key = `account_spend_alert:${hour}:${userId}`;
    if (known.has(key)) return;
    const spent = await spentInHour(userId, hour);
    if (spent < threshold) return;
    if (await isOwner(userId)) { known.add(key); return; }
    const claimed = await claimOnce(key);
    known.add(key);
    if (claimed.state !== "won") return;
    const context = { userId, hour: `${hour}:00 UTC`, spent: Number(spent.toFixed(2)), threshold };
    log("warn", "spend_alert.account_hour", { ...context, message: `Un compte a dépensé ${context.spent} $ d'IA dans l'heure (seuil ${threshold} $).` });
    captureError(
      new Error(`Dépense IA d'un compte au-dessus de ${threshold} $ dans l'heure ${context.hour} (${context.spent} $) : compte dans le journal spend_alert.account_hour.`),
      { alert: "account_spend_hour" },
    );
    // Un worker de job sort juste après son dernier appel : sans attente, l'envoi se perdrait.
    await flushErrorTracking(1_000);
    await settleClaim(key, claimed.token);
  } catch (e) {
    log("warn", "spend_alert.account_hour_failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
  }
}
