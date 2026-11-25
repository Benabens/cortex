import { randomUUID } from "node:crypto";
import { authGet, authRun } from "@/db/auth-store";

/**
 * ENVOI UNIQUE entre plusieurs process (serveur, workers de jobs, redéploiement
 * chevauchant) : avant d'envoyer, un process RÉCLAME une clé dans `app_meta`,
 * dont la clé primaire ne laisse passer que lui. Sert aux alertes de dépense
 * (lib/billing/spend-alerts, et par compte et par heure lib/billing/account-spend-alerts),
 * au rappel de reconduction de l'abonnement annuel (lib/billing/renewal-reminders), à
 * l'alerte de ses échecs (lib/billing/renewal-alerts), au reçu Cortex après paiement
 * (lib/billing/receipts), au bilan d'exploitation (lib/ops-digest) et aux alertes du
 * webhook Railway (lib/railway-webhook).
 *
 * Valeur de la ligne : un jeton « date chaîne essai » tant que l'envoi est en
 * cours, puis « sent » (suivi ou non de la date d'envoi) une fois parti. La
 * chaîne nomme une suite d'essais dont on ne sait pas si l'un a abouti : elle
 * passe à qui reprend une réclamation restée sans suite, et sert de clé
 * d'idempotence chez Resend. Un refus net clôt la chaîne : l'appelant rend la clé.
 */
export const SENT = "sent";
/** Passé ce délai, une réclamation jamais conclue est celle d'un process mort. */
export const STALE_CLAIM_MS = 15 * 60_000;

export type Claim = { state: "won"; token: string; chain: string } | { state: "sent" } | { state: "busy" };

export function isSent(value: string | null | undefined): boolean {
  return value === SENT || !!value?.startsWith(`${SENT} `);
}

/**
 * Réclame la clé : « won » pour UN seul process ; « sent » si l'envoi est déjà
 * fait, « busy » si un autre process s'en occupe. Écriture puis relecture d'un
 * jeton propre à cet essai, plutôt qu'un RETURNING : `authRun` attend la fin
 * d'une transaction sqlite en cours, dont un ROLLBACK emporterait la ligne.
 */
export async function claimOnce(key: string): Promise<Claim> {
  const read = async () => (await authGet<{ value: string }>(`SELECT value FROM app_meta WHERE key = ?`, key))?.value;
  const mint = (chain: string) => `${new Date().toISOString()} ${chain} ${randomUUID()}`;
  const chain = randomUUID();
  const token = mint(chain);
  await authRun(`INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`, key, token);
  const held = await read();
  if (held === token) return { state: "won", token, chain };
  if (isSent(held)) return { state: "sent" };
  if (held === undefined) return { state: "busy" };
  // Réclamé ailleurs et jamais conclu : passé un quart d'heure, son process est mort.
  const [since, heldChain] = held.split(" ");
  if (!heldChain || !(Date.now() - Date.parse(since) > STALE_CLAIM_MS)) return { state: "busy" };
  const takeover = mint(heldChain);
  await authRun(`UPDATE app_meta SET value = ? WHERE key = ? AND value = ?`, takeover, key, held);
  return (await read()) === takeover ? { state: "won", token: takeover, chain: heldChain } : { state: "busy" };
}

/** Conclut la réclamation (envoi parti). Seul le détenteur du jeton écrit. */
export async function settleClaim(key: string, token: string, value: string = SENT): Promise<void> {
  await authRun(`UPDATE app_meta SET value = ? WHERE key = ? AND value = ?`, value, key, token);
}

/** Rend la clé après un refus net (rien n'est parti). Seul le détenteur du jeton efface : un process repris entre-temps garde son travail. */
export async function releaseClaim(key: string, token: string): Promise<void> {
  await authRun(`DELETE FROM app_meta WHERE key = ? AND value = ?`, key, token);
}

/**
 * État d'une clé sans la réclamer : envoyée (`at` = date d'envoi, si la valeur la porte), en
 * cours depuis `since`, ou libre (null). Le format de la valeur reste l'affaire de ce module.
 */
export async function peekClaim(key: string): Promise<{ state: "sent"; at: number | null } | { state: "pending"; since: number } | null> {
  const held = (await authGet<{ value: string }>(`SELECT value FROM app_meta WHERE key = ?`, key))?.value;
  if (held === undefined) return null;
  if (isSent(held)) {
    const at = Date.parse(held.split(" ")[1] ?? "");
    return { state: "sent", at: Number.isFinite(at) ? at : null };
  }
  return { state: "pending", since: Date.parse(held.split(" ")[0]) };
}
