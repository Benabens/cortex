import type Stripe from "stripe";

/**
 * MARQUE CORTEX CHEZ STRIPE, par session. Le compte Stripe est PARTAGÉ (Kairo) :
 * son nom public, son icône et son adresse sont ceux de l'entreprise, et on n'y
 * touche pas. Ce que Stripe permet de poser par session ne vaut QUE pour la page
 * de paiement (`branding_settings`) : le reçu, la facture issue de
 * `invoice_creation`, le portail client et les e-mails automatiques suivent les
 * réglages du compte. D'où le reçu et la facture de Cortex (./receipts,
 * ./invoice-pdf). État complet : docs/STRIPE-LIVE.md § 2 bis.
 *
 * Images : servies par l'app sous /brand/ (public dans proxy.ts), que Stripe
 * télécharge. Le logo est le lockup « Dissolution v2 » pour fond sombre (kit bleu
 * du 04/11/2026), l'icône celle de l'app (favicon de la page). Sur une origine
 * locale (http), Stripe ne pourrait pas les lire : la session part sans image.
 */

/** Couleurs de la page de paiement : fond sombre de l'app (--color-bg), bouton à l'accent (--color-accent). */
export const CHECKOUT_COLORS = { background: "#080c14", button: "#2764ec" } as const;

export const BRAND_LOGO_PATH = "/brand/cortex-lockup-dark.png";
export const BRAND_ICON_PATH = "/brand/icon-512.png";

export function checkoutBranding(origin: string): Stripe.Checkout.SessionCreateParams.BrandingSettings {
  const images = origin.startsWith("https://")
    ? { logo: { type: "url" as const, url: `${origin}${BRAND_LOGO_PATH}` }, icon: { type: "url" as const, url: `${origin}${BRAND_ICON_PATH}` } }
    : {};
  return {
    display_name: "Cortex",
    ...images,
    background_color: CHECKOUT_COLORS.background,
    button_color: CHECKOUT_COLORS.button,
    border_style: "rounded",
    // Police système, comme l'app : la liste de Stripe n'a pas Funnel Display, et Inter est écartée (anti-slop).
    font_family: "default",
  };
}
