import { authAll, authRun } from "@/db/auth-store";
import { nowStr, q } from "@/db/q";
import { intLimit } from "@/lib/billing/env";
import { originalsPolicy } from "@/lib/originals/policy";

/**
 * QUOTA D'INDEX D'UN COMPTE GRATUIT. Ses originaux ne restent pas sur le serveur (lib/originals) :
 * ce qu'il occupe, c'est l'index (le texte extrait de ses supports). Il est relevé par cours à
 * chaque ingestion (table `index_usage` de la base des comptes) et borné par INDEX_QUOTA_MB
 * (défaut 25 Mo de texte, soit plusieurs milliers de pages ; `unlimited` = aucune borne). Un envoi
 * est refusé quand le quota est déjà atteint : le dépassement possible est d'un envoi au plus.
 * Premium et propriétaire : le quota de stockage habituel (lib/storage-quota) s'applique seul.
 */

const MiB = 1024 * 1024;

export function indexQuotaBytes(): number | null {
  const mb = intLimit("INDEX_QUOTA_MB", 25);
  return mb === null ? null : mb * MiB;
}

/** Taille de l'index du cours courant : texte et HTML de ses passages (caractères ≈ octets). */
export async function courseIndexBytes(): Promise<number> {
  await q.ensureTable("items");
  const r = await q.get<{ n: number | string | null }>(`SELECT sum(length(text) + coalesce(length(html), 0)) AS n FROM items`);
  return Number(r?.n ?? 0) || 0;
}

export async function recordIndexUsage(userId: string, course: string, bytes: number): Promise<void> {
  await authRun(
    `INSERT INTO index_usage (user_id, course, bytes, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(user_id, course) DO UPDATE SET bytes = excluded.bytes, updated_at = excluded.updated_at`,
    userId, course, Math.max(0, Math.round(bytes)), nowStr(),
  );
}

export async function accountIndexBytes(userId: string): Promise<number> {
  const rows = await authAll<{ n: number | string | null }>(`SELECT sum(bytes) AS n FROM index_usage WHERE user_id = ?`, userId);
  return Number(rows[0]?.n ?? 0) || 0;
}

/** Relève l'index du cours courant (fin d'ingestion, source retirée). Jamais bloquant. */
export async function refreshIndexUsage(userId: string, course: string): Promise<void> {
  try {
    await recordIndexUsage(userId, course, await courseIndexBytes());
  } catch { /* base des comptes indisponible : relevé à la prochaine ingestion */ }
}

/** Refus 413 quand un compte gratuit a rempli son index ; null = l'envoi peut passer. */
export async function checkIndexQuota(userId: string): Promise<{ status: 413; error: string } | null> {
  const quota = indexQuotaBytes();
  if (quota === null) return null;
  if ((await originalsPolicy(userId)).home !== "local") return null;
  const used = await accountIndexBytes(userId).catch(() => 0);
  if (used < quota) return null;
  const mb = (n: number) => Math.max(1, Math.round(n / MiB));
  return {
    status: 413,
    error: `Index plein : ${mb(used)} Mo de texte indexé sur ${mb(quota)} Mo (compte gratuit). Retire des supports dont tu n'as plus besoin (page Sources), ou passe Premium pour en ajouter.`,
  };
}
