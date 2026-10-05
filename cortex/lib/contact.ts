/**
 * ADRESSE DE CONTACT affichée dans l'app : pied de page, écran de connexion,
 * messages qui renvoient vers le support. Source unique — CONTACT_EMAIL la
 * remplace partout (support@… le jour où le domaine reçoit du courrier). Les
 * pages légales de la vitrine portent la leur.
 */
const DEFAULT_CONTACT_EMAIL = "abensur.benjamin@gmail.com";

/** Adresse simple, sans rien qui puisse déborder d'un lien `mailto:`. */
const PLAIN_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function contactEmail(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  const raw = env.CONTACT_EMAIL?.trim();
  return raw && PLAIN_EMAIL.test(raw) ? raw : DEFAULT_CONTACT_EMAIL;
}
