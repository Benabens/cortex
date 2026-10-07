import { authAll, authRun } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { sendEmail, type EmailOutcome } from "@/lib/email";
import { log } from "@/lib/metrics";

/**
 * ALERTES DE DÉPENSE : un e-mail au propriétaire quand la dépense du mois
 * franchit 80 % du plafond global, puis un à 100 %.
 *
 * UNE fois par seuil, par mois et par valeur du plafond, même avec plusieurs
 * instances (serveur, workers de jobs, redéploiement chevauchant) : le seuil
 * est RÉCLAMÉ par un INSERT dans `app_meta`, dont la clé primaire ne laisse
 * passer qu'un process. Le plafond fait partie de la clé : le relever en cours
 * de mois réarme les alertes sur la nouvelle valeur.
 *
 * Envoi impossible (pas de clé Resend, pas de destinataire, panne) : le seuil
 * est rendu, et retenté au plus une fois par heure et par process. Un process
 * tué entre la réclamation et l'envoi perd l'alerte de ce seuil : jamais deux
 * e-mails, au pire aucun.
 */
const THRESHOLDS = [80, 100] as const;
const RETRY_MS = 60 * 60_000;

/** Seuils envoyés par ce process : plus aucune requête pour eux. */
const sent = new Set<string>();
/** Seuils à ne pas retenter avant cette heure (réclamés ailleurs, ou envoi raté ici). */
const notBefore = new Map<string, number>();

/** (tests) oublie ce que ce process sait des alertes, comme au démarrage. */
export function resetSpendAlerts(): void {
  sent.clear();
  notBefore.clear();
}

function recipient(): string | null {
  return process.env.CORTEX_OWNER_EMAIL?.trim() || process.env.PUBLISHER_EMAIL?.trim() || null;
}

async function send(pct: number, spent: number, cap: number, month: string): Promise<EmailOutcome> {
  const to = recipient();
  if (!to) return { ok: false, reason: "aucun destinataire : pose CORTEX_OWNER_EMAIL ou PUBLISHER_EMAIL" };
  const figures = `Dépense IA de Cortex pour ${month} : ${spent.toFixed(2)} $, soit ${Math.floor((spent / cap) * 100)} % du plafond mensuel (SPEND_CAP_USD = ${cap} $).`;
  const reopen = "Pour relever le plafond : Railway, service cortex-app, Variables, SPEND_CAP_USD.";
  return pct >= 100
    ? sendEmail({
        to,
        subject: "Cortex : plafond de dépense IA du mois atteint, génération coupée",
        text: `${figures}\n\nLe plafond est atteint : toute génération payante est refusée jusqu'au 1er du mois prochain (UTC). Le reste du site fonctionne.\n\n${reopen}`,
      })
    : sendEmail({
        to,
        subject: `Cortex : ${pct} % du plafond de dépense IA du mois`,
        text: `${figures}\n\nÀ 100 %, toute génération payante sera refusée jusqu'au 1er du mois prochain (UTC).\n\n${reopen}`,
      });
}

/** Envoie les alertes dues pour cette dépense. L'appelant garantit `cap > 0`. */
export async function alertSpendThresholds(spent: number, cap: number, month: string): Promise<void> {
  for (const pct of THRESHOLDS) {
    if (spent < (cap * pct) / 100) continue;
    const key = `spend_alert:${month}:${pct}:${cap}`;
    if (sent.has(key) || (notBefore.get(key) ?? 0) > Date.now()) continue;
    notBefore.set(key, Date.now() + RETRY_MS);
    const claimed = await authAll<{ key: string }>(
      `INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING RETURNING key`, key, nowStr(),
    );
    if (claimed.length !== 1) continue; // une autre instance s'en charge, ou l'a déjà fait
    const outcome = await send(pct, spent, cap, month);
    if (outcome.ok) {
      sent.add(key);
      log("info", "spend_alert.sent", { month, threshold: pct, spent: Number(spent.toFixed(2)), cap });
      continue;
    }
    await authRun(`DELETE FROM app_meta WHERE key = ?`, key);
    log("warn", "spend_alert.not_sent", {
      month, threshold: pct, spent: Number(spent.toFixed(2)), cap, reason: outcome.reason,
      message: `Alerte de dépense non envoyée (${outcome.reason}) : nouvelle tentative dans une heure.`,
    });
  }
}
