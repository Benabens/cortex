import { currentUser } from "@/db/context";

/**
 * MODE PROPRIÉTAIRE — LE point de décision unique : le compte du propriétaire de
 * l'instance (CORTEX_OWNER_USER_ID, sinon CORTEX_OWNER_EMAIL) n'est arrêté ni par
 * les crédits, ni par les quotas du jour, ni par le débit par minute, ni par le
 * plafond de générations simultanées : rien n'est débité ni compté contre lui.
 * Restent actifs pour lui comme pour tous : les plafonds de DÉPENSE réelle chez le
 * fournisseur (SPEND_CAP_USD du mois et SPEND_CAP_PER_USER_USD du jour — sans ce
 * dernier, une boucle sur son compte couperait la génération de tous), la limite
 * par compte du point MCP, l'enregistrement des coûts dans llm_usage et le quota
 * de stockage.
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
