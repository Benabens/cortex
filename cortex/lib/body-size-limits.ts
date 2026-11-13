/**
 * Plafonds des corps d'envoi, SANS dépendance à Next : `next.config.ts` les lit
 * pour régler la borne du proxy, les routes via `lib/upload-limit`.
 *
 * Le proxy (`proxy.ts`, matcher sur `/api/*`) tamponne le corps et le TRONQUE
 * au-delà de `proxyClientMaxBodySize` (10 Mo par défaut) : la route reçoit alors
 * un multipart coupé et répond un 400 obscur au lieu d'un 413 explicite (vu en
 * prod le 13/11/2026, annales de plus de 10 Mo). La borne du proxy est donc
 * DÉRIVÉE du plus grand plafond de route, jamais recopiée à la main.
 */

export const MiB = 1024 * 1024;

/** Plafonds par route (octets). Env : UPLOAD_MAX_MB relève/abaisse le défaut « refs ». */
export const UPLOAD_LIMITS = {
  /** Annales (plusieurs PDF par envoi). */
  refs: (Number(process.env.UPLOAD_MAX_MB) > 0 ? Number(process.env.UPLOAD_MAX_MB) : 64) * MiB,
  /** Un fichier de source (30 Mo max côté fichier) + enveloppe multipart. */
  source: 32 * MiB,
  /** Un fichier d'un dossier de cours (30 Mio + enveloppe multipart). */
  folderFile: 32 * MiB,
  /** Une photo (12 Mo max côté fichier) + champs texte. */
  image: 16 * MiB,
} as const;

/** Marge au-dessus du plus grand plafond : la route doit voir l'excès pour rendre son 413. */
const PROXY_MARGIN = 1 * MiB;

/** Borne du proxy Next (octets) : plus grand plafond de route + marge. */
export function proxyBodyLimitBytes(limits: Record<string, number> = UPLOAD_LIMITS): number {
  return Math.max(...Object.values(limits)) + PROXY_MARGIN;
}
