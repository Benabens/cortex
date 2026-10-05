import type Stripe from "stripe";
import { PLANS, type PlanKey } from "./stripe-events";
import { publicOrigin } from "@/lib/public-url";

/** Origine canonique du site (AUTH_URL), ou null. */
export function siteOrigin(): string | null {
  return publicOrigin();
}

/** Paramètres de la session Checkout, testables sans réseau hors du module de route Next.js. */
export function checkoutParams(o: { plan: PlanKey; priceId: string; userId: string; email?: string | null }): Stripe.Checkout.SessionCreateParams & { metadata: Record<string, string> } {
  const origin = siteOrigin();
  if (!origin) throw new Error("AUTH_URL manquante");
  const spec = PLANS[o.plan];
  // `app` : le compte Stripe peut être PARTAGÉ avec d'autres applications — le webhook ne traite que ce qui porte Cortex.
  const metadata: Record<string, string> = { app: "cortex", cortexUserId: o.userId, plan: o.plan, ...(spec.credits ? { credits: String(spec.credits) } : {}) };
  return {
    mode: spec.mode,
    line_items: [{ price: o.priceId, quantity: 1 }],
    success_url: `${origin}/compte?achat=ok`,
    cancel_url: `${origin}/compte?achat=annule`,
    ...(o.email ? { customer_email: o.email } : {}),
    // Le webhook lit CES métadonnées pour attribuer au bon compte (source de vérité).
    metadata,
    ...(spec.mode === "payment"
      // Pack : facture émise (obligation légale), client Stripe créé pour rattacher remboursements et litiges.
      // …et métadonnées sur le PaymentIntent : la charge d'un remboursement les porte, même si l'achat est inconnu en base.
      ? {
          invoice_creation: { enabled: true },
          customer_creation: "always" as const,
          payment_intent_data: { metadata, statement_descriptor_suffix: "CORTEX" },
        }
      // Abonnement : métadonnées aussi sur l'abonnement → une facture arrivée avant le checkout retrouve l'utilisateur.
      : { subscription_data: { metadata } }),
  };
}
