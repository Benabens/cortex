import { billingEnabled } from "./billing/credits";

/**
 * DOCUMENTS LÉGAUX ET OUVERTURE DES ACHATS.
 *
 * Les textes (CGV, confidentialité, remboursement, mentions légales) vivent sur
 * le site vitrine, en français (version qui fait foi ; chaque page renvoie à sa
 * traduction anglaise). L'app ne connaît que leurs URLs : déclarer la vitrine
 * (LANDING_URL) suffit, un LEGAL_*_URL explicite prime. On n'encaisse pas sans
 * CGV : en production avec la facturation active, s'il manque un des quatre
 * liens, l'achat reste fermé (bouton désactivé, checkout refusé). L'acceptation
 * des CGV est tracée par utilisateur avec la version du texte
 * (LEGAL_TERMS_VERSION) : changer la version redemande l'acceptation.
 */

export type LegalLinks = { terms: string | null; privacy: string | null; refund: string | null; notice: string | null };

function urlOrNull(v: string | undefined): string | null {
  const raw = v?.trim();
  if (!raw) return null;
  try { return new URL(raw).toString(); } catch { return null; }
}

/** Origine de la vitrine si elle est DÉCLARÉE (LANDING_URL, http ou https), sinon null. */
export function landingOrigin(env: Partial<NodeJS.ProcessEnv> = process.env): string | null {
  const raw = env.LANDING_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch { return null; }
}

/** Vitrine vers laquelle l'écran de connexion renvoie quand aucune n'est déclarée (affichage seul : n'ouvre jamais la vente). */
export const DEFAULT_LANDING_URL = "https://cortex-landing-seven.vercel.app";

/** Chemins des documents sur la vitrine (pages françaises). */
const LANDING_PATHS: Record<keyof LegalLinks, string> = {
  terms: "/terms", privacy: "/privacy", refund: "/remboursement", notice: "/mentions-legales",
};

export function legalLinks(env: Partial<NodeJS.ProcessEnv> = process.env): LegalLinks {
  // Jamais de vitrine supposée : sans LANDING_URL ni lien explicite, le document
  // n'est pas réputé publié et la vente reste fermée (purchasesAllowed).
  const landing = landingOrigin(env);
  const link = (explicit: string | undefined, doc: keyof LegalLinks) =>
    urlOrNull(explicit) ?? (landing ? `${landing}${LANDING_PATHS[doc]}` : null);
  return {
    terms: link(env.LEGAL_TERMS_URL, "terms"),
    privacy: link(env.LEGAL_PRIVACY_URL, "privacy"),
    refund: link(env.LEGAL_REFUND_URL, "refund"),
    notice: link(env.LEGAL_NOTICE_URL, "notice"),
  };
}

export function legalReady(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  const l = legalLinks(env);
  return !!(l.terms && l.privacy && l.refund && l.notice);
}

/** Version courante des CGV (chaîne libre : date de publication). */
export function termsVersion(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  return env.LEGAL_TERMS_VERSION?.trim() || "2026-10";
}

export function stripeConfigured(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}

/** Clé Stripe LIVE (secrète ou restreinte) ? Toute autre clé accepte les cartes de test. */
export function stripeLiveKey(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY ?? "");
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
  // Une clé de TEST accepte les cartes de test : en production ouverte à tous,
  // chacun s'offrirait de vrais crédits. La vente publique attend la clé live ;
  // la clé de test reste utilisable en lancement fermé (INVITE_ONLY=1) et hors production.
  if (env.NODE_ENV === "production" && !stripeLiveKey(env) && env.INVITE_ONLY !== "1") {
    return { enabled: false, reason: "Les achats ouvrent bientôt : le paiement n'est pas encore activé." };
  }
  return { enabled: true, reason: null };
}

export type TermsState = {
  version: string;
  accepted: boolean;
  acceptedAt: string | null;
  /** Accord exprès à l'exécution immédiate + reconnaissance de la perte du droit de rétractation (L221-28 13° C. conso). */
  withdrawalAccepted: boolean;
  withdrawalAcceptedAt: string | null;
};

/** État d'acceptation de la version COURANTE des CGV pour un utilisateur. */
export async function termsState(userId: string, env: Partial<NodeJS.ProcessEnv> = process.env): Promise<TermsState> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { authGet } = require("@/db/auth-store") as typeof import("@/db/auth-store");
  const version = termsVersion(env);
  const row = await authGet<{ accepted_at: string; withdrawal_waiver_at: string | null }>(
    `SELECT accepted_at, withdrawal_waiver_at FROM terms_acceptances WHERE user_id = ? AND version = ?`, userId, version,
  );
  return {
    version,
    accepted: !!row,
    acceptedAt: row?.accepted_at ?? null,
    withdrawalAccepted: !!row?.withdrawal_waiver_at,
    withdrawalAcceptedAt: row?.withdrawal_waiver_at ?? null,
  };
}

/** Libellé de la renonciation, identique à l'écran et dans les traces. */
export const WITHDRAWAL_WAIVER_TEXT =
  "Je demande l’accès immédiat au service et reconnais perdre mon droit de rétractation dès l’utilisation de mes crédits.";
