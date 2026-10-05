/**
 * OUVERTURE DES INSCRIPTIONS. Par défaut, toute adresse peut créer un compte.
 * INVITE_ONLY=1 ferme l'instance (lancement fermé) : seules passent les
 * adresses d'INVITE_EMAILS, séparées par des virgules — une entrée commençant
 * par « @ » autorise tout le domaine (ex. @epfl.ch).
 */
export function inviteAllows(email: string | null | undefined, env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  if (env.INVITE_ONLY !== "1") return true;
  const addr = (email ?? "").trim().toLowerCase();
  if (!addr) return false;
  const allow = (env.INVITE_EMAILS ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return allow.some((a) => (a.startsWith("@") ? addr.endsWith(a) : a === addr));
}
