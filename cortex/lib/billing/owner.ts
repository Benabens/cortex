import { currentUser } from "@/db/context";

/**
 * MODE PROPRIÉTAIRE — LE point de décision unique : le compte du propriétaire de
 * l'instance (CORTEX_OWNER_USER_ID, sinon CORTEX_OWNER_EMAIL) n'est arrêté ni par
 * les crédits, ni par les quotas du jour, ni par le débit par minute, ni par le
 * plafond de générations simultanées, ni par le budget IA lié au revenu (ni sa
 * dépense par le plafond global lié au revenu) : rien n'est débité ni compté
 * contre lui. Son quota de stockage est le plafond (STORAGE_QUOTA_MAX_MB).
 * Il n'est pas non plus arrêté par le fusible du jour par compte
 * SPEND_CAP_PER_USER_USD (décision de Ben, 15/11 : ses propres jobs ne doivent plus
 * échouer en route). Restent actifs pour lui comme pour tous : le fusible global
 * de DÉPENSE réelle chez le fournisseur (SPEND_CAP_USD du mois, qui borne aussi une
 * boucle sur son compte), la limite par compte du point MCP, l'enregistrement des
 * coûts dans llm_usage et la borne de stockage du volume.
 *
 * OPT-IN : sans variable de propriétaire posée, personne n'est exempté — le repli
 * « owner » du mode mono-utilisateur (isOwnerAccount) ne vaut pas exemption.
 * Toute erreur de lecture (base indisponible) vaut « pas propriétaire » : les
 * limites normales s'appliquent.
 */
export async function isOwner(userId: string = currentUser(), env: Partial<NodeJS.ProcessEnv> = process.env): Promise<boolean> {
  if (!env.CORTEX_OWNER_USER_ID?.trim() && !env.CORTEX_OWNER_EMAIL?.trim()) return false;
  // Import à la demande : credits.ts (donc ce module) est lu par de nombreuses pages, account-deletion tire jobs et llm.
  const { isOwnerAccount } = await import("@/lib/account-deletion");
  return isOwnerAccount(userId, env).catch(() => false);
}

/**
 * Ids des comptes propriétaires (pour les exclure d'une somme : la dépense du
 * propriétaire n'est garantie par aucun paiement, elle n'entre pas dans le
 * plafond lié au revenu). Vide sans variable de propriétaire ; erreur de base → vide.
 */
export async function ownerUserIds(env: Partial<NodeJS.ProcessEnv> = process.env): Promise<string[]> {
  const explicitId = env.CORTEX_OWNER_USER_ID?.trim();
  if (explicitId) return [explicitId];
  const email = env.CORTEX_OWNER_EMAIL?.trim();
  if (!email) return [];
  const { authAll } = await import("@/db/auth-store");
  const rows = await authAll<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower(?)`, email).catch(() => []);
  return rows.map((r) => r.id);
}
