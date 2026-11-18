import { createHash } from "node:crypto";
import { authTx } from "@/db/auth-store";
import { dbDriverName } from "@/db/q";
import { personKey } from "@/lib/email-identity";

/**
 * Limites d'envoi du lien magique (audit fuites B4). Chaque envoi coûte un e-mail Resend :
 * sans limite, un script qui boucle sur la demande de lien vide le quota (ou fait suspendre
 * le compte) et plus personne ne se connecte par e-mail. Compté EN BASE (store global), donc
 * commun à tous les process et intact après un redémarrage.
 *
 *  - par adresse : MAGIC_LINK_PER_MINUTE (1) et MAGIC_LINK_PER_DAY (5) ;
 *  - par IP : MAGIC_LINK_PER_IP_HOUR (20), seulement derrière TRUST_PROXY. Sans lui, toutes
 *    les requêtes ont la clé « direct » (lib/client-ip) : la borner bloquerait le site entier.
 *
 * Adresse et IP sont hachées : la table ne sert qu'à compter, elle ne garde ni l'une ni l'autre.
 */

export type MagicLinkVerdict = { ok: true } | { ok: false; reason: "address_minute" | "address_day" | "ip_hour" };

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Lignes plus vieilles que la plus longue fenêtre (un jour), avec de la marge. */
const PURGE_AFTER_MS = 2 * DAY;

/**
 * Absente → la valeur par défaut, même sans AUTH_ENABLED (pas `intLimit`, qui n'en met qu'en
 * déploiement gardé : une limite d'envoi qui saute en silence coûterait le quota Resend).
 */
function limit(name: string, def: number): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return def;
  if (/^(unlimited|none|off|-1)$/i.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

const at = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const key = (kind: string, value: string) => createHash("sha256").update(`${kind}:${value}`).digest("hex").slice(0, 32);


/**
 * Décide ET compte un envoi : `ok` réserve la place (la ligne est écrite), un refus n'écrit rien.
 * `ip` vient de clientIp() ; « direct » (pas de TRUST_PROXY) n'est jamais borné par IP.
 */
export async function takeMagicLinkSend(email: string, ip: string, now = Date.now()): Promise<MagicLinkVerdict> {
  // Une boîte = une clé (lib/email-identity) : « +étiquette » et points Gmail ne font pas de nouvelle adresse.
  const addressKey = key("address", personKey(email));
  const ipKey = ip && ip !== "direct" ? key("ip", ip) : null;
  const perMinute = limit("MAGIC_LINK_PER_MINUTE", 1);
  const perDay = limit("MAGIC_LINK_PER_DAY", 5);
  const perIpHour = limit("MAGIC_LINK_PER_IP_HOUR", 20);

  return authTx(async (tx) => {
    // Deux demandes simultanées ne passent pas toutes les deux sous la limite.
    if (dbDriverName() === "postgres") await tx.run(`SELECT pg_advisory_xact_lock(hashtext(?))`, "magic-link-sends");
    const count = async (column: "address_key" | "ip_key", value: string, sinceMs: number) =>
      Number((await tx.get<{ n: number }>(
        `SELECT count(*) n FROM magic_link_sends WHERE ${column} = ? AND created_at > ?`, value, at(now - sinceMs),
      ))?.n ?? 0);

    if (perMinute !== null && (await count("address_key", addressKey, MIN)) >= perMinute) return { ok: false, reason: "address_minute" } as const;
    if (perDay !== null && (await count("address_key", addressKey, DAY)) >= perDay) return { ok: false, reason: "address_day" } as const;
    if (ipKey && perIpHour !== null && (await count("ip_key", ipKey, 60 * MIN)) >= perIpHour) return { ok: false, reason: "ip_hour" } as const;

    await tx.run(`DELETE FROM magic_link_sends WHERE created_at < ?`, at(now - PURGE_AFTER_MS));
    await tx.run(`INSERT INTO magic_link_sends (address_key, ip_key, created_at) VALUES (?, ?, ?)`, addressKey, ipKey, at(now));
    return { ok: true } as const;
  });
}

/** Code d'erreur de /login pour chaque refus (messages dans app/login/LoginCard). */
export const MAGIC_LINK_REFUSAL_CODE: Record<Exclude<MagicLinkVerdict, { ok: true }>["reason"], string> = {
  address_minute: "EmailWait",
  address_day: "EmailDay",
  ip_hour: "EmailIp",
};
