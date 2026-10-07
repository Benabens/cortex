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
 * Reprises, au prochain appel payant (il n'y a pas de minuterie) :
 *  - refus net de Resend : rien n'est parti, le seuil est rendu et retenté au
 *    plus une fois par heure et par process ;
 *  - issue inconnue (pas de réponse, worker tué en plein envoi) : la
 *    réclamation reste, et un process la reprend au bout d'un quart d'heure
 *    sous la MÊME clé d'idempotence Resend (retenue 24 h), qui écarte le doublon.
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

type Claim = { state: "won"; token: string; chain: string } | { state: "sent" } | { state: "busy" };

/**
 * Réclame le seuil : « won » pour UN seul process ; « sent » s'il est déjà
 * signalé, « busy » si un autre process s'en occupe. Écriture puis relecture
 * d'un jeton propre à cet essai, plutôt qu'un RETURNING : `authRun` attend la
 * fin d'une transaction sqlite en cours, dont un ROLLBACK emporterait la ligne.
 *
 * Jeton : « date chaîne essai ». La chaîne nomme une suite d'essais dont on ne
 * sait pas si l'un a abouti : elle passe à qui reprend une réclamation restée
 * sans suite, et sert de clé d'idempotence. Un refus net clôt la chaîne.
 */
async function claim(key: string): Promise<Claim> {
  const read = async () => (await authGet<{ value: string }>(`SELECT value FROM app_meta WHERE key = ?`, key))?.value;
  const mint = (chain: string) => `${new Date().toISOString()} ${chain} ${randomUUID()}`;
  const chain = randomUUID();
  const token = mint(chain);
  await authRun(`INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`, key, token);
  const held = await read();
  if (held === token) return { state: "won", token, chain };
  if (held === SENT) return { state: "sent" };
  if (held === undefined) return { state: "busy" };
  // Réclamé ailleurs et jamais conclu : passé un quart d'heure, son process est mort.
  const [since, heldChain] = held.split(" ");
  if (!heldChain || !(Date.now() - Date.parse(since) > STALE_CLAIM_MS)) return { state: "busy" };
  const takeover = mint(heldChain);
  await authRun(`UPDATE app_meta SET value = ? WHERE key = ? AND value = ?`, takeover, key, held);
  return (await read()) === takeover ? { state: "won", token: takeover, chain: heldChain } : { state: "busy" };
}

function send(idempotencyKey: string, pct: number, spent: number, cap: number, month: string): Promise<EmailOutcome> {
  const to = recipient(process.env)!;
  const figures = `Dépense IA de Cortex pour ${month} : ${spent.toFixed(2)} $, soit ${Math.floor((spent / cap) * 100)} % du plafond mensuel (SPEND_CAP_USD = ${cap} $).`;
  const reopen = "Pour relever le plafond : Railway, service cortex-app, Variables, SPEND_CAP_USD.";
  return pct >= 100
    ? sendEmail({
        to, idempotencyKey,
        subject: "Cortex : plafond de dépense IA du mois atteint, génération coupée",
        text: `${figures}\n\nLe plafond est atteint, appels en cours compris : les nouvelles générations payantes sont refusées. Sans changement, cela dure jusqu'au 1er du mois prochain (UTC). Le reste du site fonctionne.\n\n${reopen}`,
      })
    : sendEmail({
        to, idempotencyKey,
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
      await authRun(`INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, SENT);
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
    if (claimed.state === "busy") {
      // Un autre process s'en occupe : on y revient dans un quart d'heure, au cas où il serait mort.
      // Tant que son e-mail n'est pas parti, il ne couvre aucun seuil plus bas.
      notBefore.set(key, Date.now() + STALE_CLAIM_MS);
      return;
    }
    if (claimed.state === "sent") { settled.add(key); covered = true; continue; }
    const outcome = await send(`${key}:${claimed.chain}`, pct, spent, cap, month);
    if (!outcome.ok) {
      // Seul le détenteur du jeton rend le seuil : un process repris entre-temps n'efface pas le travail d'un autre.
      if (!outcome.uncertain) await authRun(`DELETE FROM app_meta WHERE key = ? AND value = ?`, key, claimed.token);
      const next = outcome.uncertain ? "reprise dans un quart d'heure, sans doublon possible" : "nouvelle tentative dans une heure";
      log("warn", "spend_alert.not_sent", { ...context, reason: outcome.reason, message: `Alerte de dépense non envoyée (${outcome.reason}) : ${next}.` });
      return;
    }
    await authRun(`UPDATE app_meta SET value = ? WHERE key = ? AND value = ?`, SENT, key, claimed.token);
    settled.add(key);
    log("info", "spend_alert.sent", context);
    covered = true;
  }
}
