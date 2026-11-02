/**
 * Message À MONTRER à l'utilisateur pour un échec d'appel au modèle. Le texte
 * brut d'un fournisseur (« 529 overloaded_error… ») ne sort jamais tel quel :
 * seuls nos propres messages (gardes, plafonds) sont repris mot pour mot.
 */
const OWN_CODES = new Set(["UNAVAILABLE", "SPEND_CAP", "QUOTA", "CREDITS"]);

/** Le fournisseur a refusé ou n'a pas répondu, après les réessais espacés (rien n'a été traité). */
export const PROVIDER_DOWN_CODES = new Set(["OVERLOADED", "RATE_LIMIT", "UPSTREAM", "NETWORK"]);

/** Le modèle a répondu, mais rien d'utilisable (JSON illisible après réessais, réponse coupée). */
export const BAD_OUTPUT_CODES = new Set(["BAD_OUTPUT", "TRUNCATED"]);

export function llmErrorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Cause d'un échec, en minuscule pour se composer (« Aucun QCM généré : <cause> »). */
export function llmFailureReason(e: unknown): string {
  const code = llmErrorCode(e);
  if (code && OWN_CODES.has(code)) {
    const m = (e as Error).message;
    return m.charAt(0).toLowerCase() + m.slice(1);
  }
  if (code && PROVIDER_DOWN_CODES.has(code)) {
    return "le fournisseur d'IA est surchargé ou injoignable en ce moment, malgré plusieurs essais espacés. Réessaie dans quelques minutes.";
  }
  if (code === "TIMEOUT") return "le modèle a mis trop de temps à répondre. Réessaie dans quelques minutes.";
  if (code && BAD_OUTPUT_CODES.has(code)) return "le modèle a renvoyé une réponse illisible malgré plusieurs essais. Réessaie ; si ça se reproduit sur ce cours, signale-le.";
  if (code === "REFUSAL") return "le modèle a refusé de traiter cette demande.";
  if (code === "ABORTED") return "la génération a été annulée.";
  return "erreur inattendue du moteur d'IA. Réessaie dans un instant.";
}

/** La même cause, en phrase autonome (réponse d'API, connecteur MCP). */
export function llmUserMessage(e: unknown): string {
  const r = llmFailureReason(e);
  return r.charAt(0).toUpperCase() + r.slice(1);
}
