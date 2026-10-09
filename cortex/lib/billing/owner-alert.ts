/**
 * L'ADRESSE D'ALERTE DU PROPRIÉTAIRE, commune aux alertes de dépense
 * (./spend-alerts) et à celles du rappel de reconduction (./renewal-alerts) :
 * CORTEX_OWNER_EMAIL, à défaut PUBLISHER_EMAIL. L'envoi passe par Resend.
 */
export function ownerAlertRecipient(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.CORTEX_OWNER_EMAIL?.trim() || env.PUBLISHER_EMAIL?.trim() || null;
}

/** Ce qui empêche d'écrire au propriétaire avec la configuration courante, ou null. */
export function ownerAlertBlocker(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.RESEND_API_KEY) return "RESEND_API_KEY absente";
  if (!ownerAlertRecipient(env)) return "aucun destinataire : pose CORTEX_OWNER_EMAIL ou PUBLISHER_EMAIL";
  return null;
}
