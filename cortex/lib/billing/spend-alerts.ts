import { randomUUID } from "node:crypto";
import { authGet, authRun } from "@/db/auth-store";
import { sendEmail, type EmailOutcome } from "@/lib/email";
import { log } from "@/lib/metrics";

/**
 * ALERTES DE DÉPENSE : un e-mail au propriétaire quand la dépense du mois
 * franchit 80 % du plafond global, puis un à 100 %. Si les deux seuils sont
 * franchis d'un coup, seul celui du plafond atteint est envoyé.
 *
 * UNE fois par seuil, par mois et par valeur du plafond, même avec plusieurs
 * instances (serveur, workers de jobs, redéploiement chevauchant) : le seuil
 * est RÉCLAMÉ dans `app_meta`, dont la clé primaire ne laisse passer qu'un
 * process. Le plafond fait partie de la clé : le relever en cours de mois
 * réarme les alertes sur la nouvelle valeur.
 *
 * La clé du seuil sert aussi de clé d'idempotence chez Resend (retenue 24 h) :
 * un envoi dont la réponse s'est perdue n'est pas doublé par l'essai suivant.
 *
 * Reprises : un envoi refusé rend le seuil, retenté au plus une fois par heure
 * et par process ; une réclamation restée sans suite (worker tué en plein
 * envoi) est reprise par un autre process au bout d'un quart d'heure. Il n'y a
 * pas de minuterie : une reprise n'a lieu qu'au prochain appel payant.
 */
const THRESHOLDS = [100, 80] as const;
const RETRY_MS = 60 * 60_000;
const STALE_CLAIM_MS = 15 * 60_000;
const SENT = "sent";

/** Seuils que ce process sait signalés : plus aucune requête pour eux. */
const settled = new Set<string>();
/** Seuils à ne pas réexaminer avant cette heure (réclamés ailleurs, ou envoi impossible ici). */
const notBefore = new Map<string, number>();

/** (tests) oublie ce que ce process sait des alertes, comme au démarrage. */
export function resetSpendAlerts(): void {
  settled.clear();
  notBefore.clear();
}

function recipient(env: NodeJS.ProcessEnv): string | null {
  return env.CORTEX_OWNER_EMAIL?.trim() || env.PUBLISHER_EMAIL?.trim() || null;
}

/** Ce qui empêche d'envoyer une alerte avec la configuration courante, ou null. */
export function spendAlertBlocker(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.RESEND_API_KEY) return "RESEND_API_KEY absente";
  if (!recipient(env)) return "aucun destinataire : pose CORTEX_OWNER_EMAIL ou PUBLISHER_EMAIL";
  return null;
}

/**
 * Réclame le seuil : « won » pour UN seul process ; « sent » s'il est déjà
 * signalé, « busy » si un autre process s'en occupe. Écriture puis relecture
 * d'un jeton propre à cet essai, plutôt qu'un RETURNING : `authRun` attend la
 * fin d'une transaction sqlite en cours, dont un ROLLBACK emporterait la ligne.
 */
async function claim(key: string): Promise<"won" | "sent" | "busy"> {
  const token = `${new Date().toISOString()} ${randomUUID()}`;
  const read = async () => (await authGet<{ value: string }>(`SELECT value FROM app_meta WHERE key = ?`, key))?.value;
  await authRun(`INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`, key, token);
  const held = await read();
  if (held === token) return "won";
  if (held === SENT) return "sent";
  if (held === undefined) return "busy";
  // Réclamé ailleurs et jamais conclu : passé un quart d'heure, son process est mort.
  const age = Date.now() - Date.parse(held.split(" ")[0]);
  if (!(age > STALE_CLAIM_MS)) return "busy";
  await authRun(`UPDATE app_meta SET value = ? WHERE key = ? AND value = ?`, token, key, held);
  return (await read()) === token ? "won" : "busy";
}

function send(key: string, pct: number, spent: number, cap: number, month: string): Promise<EmailOutcome> {
  const to = recipient(process.env)!;
  const figures = `Dépense IA de Cortex pour ${month} : ${spent.toFixed(2)} $, soit ${Math.floor((spent / cap) * 100)} % du plafond mensuel (SPEND_CAP_USD = ${cap} $).`;
  const reopen = "Pour relever le plafond : Railway, service cortex-app, Variables, SPEND_CAP_USD.";
  return pct >= 100
    ? sendEmail({
        to, idempotencyKey: key,
        subject: "Cortex : plafond de dépense IA du mois atteint, génération coupée",
        text: `${figures}\n\nLe plafond est atteint, appels en cours compris : les nouvelles générations payantes sont refusées. Sans changement, cela dure jusqu'au 1er du mois prochain (UTC). Le reste du site fonctionne.\n\n${reopen}`,
      })
    : sendEmail({
        to, idempotencyKey: key,
        subject: `Cortex : ${pct} % du plafond de dépense IA du mois`,
        text: `${figures}\n\nÀ 100 %, toute génération payante sera refusée jusqu'au 1er du mois prochain (UTC).\n\n${reopen}`,
      });
}

/** Envoie l'alerte due pour cette dépense. L'appelant garantit `cap > 0`. */
export async function alertSpendThresholds(spent: number, cap: number, month: string): Promise<void> {
  // Un seuil plus haut est signalé : les plus bas sont acquis, sans e-mail.
  let covered = false;
  for (const pct of THRESHOLDS) {
    if (spent < (cap * pct) / 100) continue;
    const key = `spend_alert:${month}:${pct}:${cap}`;
    if (settled.has(key)) { covered = true; continue; }
    if (covered) {
      await authRun(`INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`, key, SENT);
      settled.add(key);
      continue;
    }
    if ((notBefore.get(key) ?? 0) > Date.now()) return;
    notBefore.set(key, Date.now() + RETRY_MS);
    const context = { month, threshold: pct, spent: Number(spent.toFixed(2)), cap };
    const blocker = spendAlertBlocker();
    if (blocker) {
      log("warn", "spend_alert.not_sent", { ...context, reason: blocker, message: `Alerte de dépense non envoyée (${blocker}) : nouvelle tentative dans une heure.` });
      return;
    }
    const claimed = await claim(key);
    if (claimed !== "won") {
      // En cours ailleurs : on y revient dans un quart d'heure, au cas où ce process-là serait mort.
      if (claimed === "sent") settled.add(key); else notBefore.set(key, Date.now() + STALE_CLAIM_MS);
      covered = true;
      continue;
    }
    const outcome = await send(key, pct, spent, cap, month);
    if (!outcome.ok) {
      await authRun(`DELETE FROM app_meta WHERE key = ?`, key);
      log("warn", "spend_alert.not_sent", { ...context, reason: outcome.reason, message: `Alerte de dépense non envoyée (${outcome.reason}) : nouvelle tentative dans une heure.` });
      return;
    }
    await authRun(`UPDATE app_meta SET value = ? WHERE key = ?`, SENT, key);
    settled.add(key);
    log("info", "spend_alert.sent", context);
    covered = true;
  }
}
