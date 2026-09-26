import { billingEnabled } from "./billing/credits";

/**
 * DOCUMENTS LÉGAUX ET OUVERTURE DES ACHATS.
 *
 * Les textes (CGV, confidentialité, remboursement, mentions légales) vivent sur
 * le site vitrine ; l'app ne connaît que leurs URLs (LEGAL_*_URL). On
 * n'encaisse pas sans CGV : en production avec la facturation active, s'il
 * manque un des quatre liens, l'achat reste fermé (bouton désactivé, checkout
 * refusé). L'acceptation des CGV est tracée par utilisateur avec la version
 * du texte (LEGAL_TERMS_VERSION) : changer la version redemande l'acceptation.
 */

export type LegalLinks = { terms: string | null; privacy: string | null; refund: string | null; notice: string | null };

function urlOrNull(v: string | undefined): string | null {
  const raw = v?.trim();
  if (!raw) return null;
  try { return new URL(raw).toString(); } catch { return null; }
}

export function legalLinks(env: Partial<NodeJS.ProcessEnv> = process.env): LegalLinks {
  return {
    terms: urlOrNull(env.LEGAL_TERMS_URL),
    privacy: urlOrNull(env.LEGAL_PRIVACY_URL),
    refund: urlOrNull(env.LEGAL_REFUND_URL),
    notice: urlOrNull(env.LEGAL_NOTICE_URL),
  };
}

export function legalReady(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  const l = legalLinks(env);
  return !!(l.terms && l.privacy && l.refund && l.notice);
}

/** Version courante des CGV (chaîne libre : date de publication). */
export function termsVersion(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  return env.LEGAL_TERMS_VERSION?.trim() || "2026-09";
}

export function stripeConfigured(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}

/** L'achat est-il ouvert ? Sinon, la raison à afficher (jamais un bouton mort sans explication). */
export function purchasesAllowed(env: Partial<NodeJS.ProcessEnv> = process.env): { enabled: boolean; reason: string | null } {
  if (!billingEnabled()) return { enabled: false, reason: "La facturation n'est pas activée sur cette instance." };
  if (!stripeConfigured(env)) return { enabled: false, reason: "Les achats ne sont pas encore ouverts : configuration du paiement incomplète." };
  // NODE_ENV=production est voulu ici (et non isGuardedDeployment) : `next start`
  // le force toujours, donc TOUTE instance servie sans les documents ferme la
  // vente ; seul `next dev` (poste de dev) peut tester un paiement sans liens.
  if (env.NODE_ENV === "production" && !legalReady(env)) {
    return { enabled: false, reason: "Les achats sont suspendus : les documents légaux (CGV, confidentialité, remboursement, mentions) ne sont pas publiés." };
  }
  return { enabled: true, reason: null };
}
