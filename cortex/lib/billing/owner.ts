import { currentUser } from "@/db/context";
import { isOwnerAccount } from "@/lib/account-deletion";

/**
 * MODE PROPRIÉTAIRE — LE point de décision unique : le compte du propriétaire de
 * l'instance (CORTEX_OWNER_USER_ID, sinon CORTEX_OWNER_EMAIL) n'est arrêté ni par
 * les crédits, ni par les quotas du jour, ni par le débit par minute, ni par le
 * plafond de générations simultanées, ni par le plafond de dépense PAR COMPTE :
 * rien n'est débité ni compté contre lui. Restent actifs pour lui comme pour tous :
 * le plafond GLOBAL du mois (SPEND_CAP_USD, la vraie dépense chez le fournisseur),
 * l'enregistrement des coûts dans llm_usage et le quota de stockage.
 *
 * OPT-IN : sans variable de propriétaire posée, personne n'est exempté — le repli
 * « owner » du mode mono-utilisateur (isOwnerAccount) ne vaut pas exemption.
 * Toute erreur de lecture (base indisponible) vaut « pas propriétaire » : les
 * limites normales s'appliquent.
 */
export async function isOwner(userId: string = currentUser(), env: Partial<NodeJS.ProcessEnv> = process.env): Promise<boolean> {
  if (!env.CORTEX_OWNER_USER_ID?.trim() && !env.CORTEX_OWNER_EMAIL?.trim()) return false;
  return isOwnerAccount(userId, env).catch(() => false);
}
