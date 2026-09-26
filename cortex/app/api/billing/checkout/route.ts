import { billingEnabled } from "@/lib/billing/credits";
import { isPlanKey, PLANS, type PlanKey } from "@/lib/billing/stripe-events";
import { authGet } from "@/db/auth-store";
import { purchasesAllowed, termsVersion } from "@/lib/legal";
import { currentUser } from "@/db/context";
import { useUser } from "@/lib/req";
import { readJson, withBodyLimit } from "@/lib/upload-limit";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Checkout Stripe — abonnement Pro (mensuel/annuel) ou pack de 10 crédits.
 * Prix référencés par LOOKUP_KEY (jamais d'ID en dur → bascule test/live sans
 * code). Le webhook attribue APRÈS paiement confirmé — jamais ici.
 * Les URLs de retour viennent d'AUTH_URL, jamais de l'en-tête Origin.
 */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  useUser(req);
  if (!billingEnabled()) {
    return NextResponse.json({ error: "Facturation désactivée (BILLING_ENABLED)." }, { status: 501 });
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return NextResponse.json({ error: "STRIPE_SECRET_KEY manquante." }, { status: 501 });
  if (!siteOrigin()) return NextResponse.json({ error: "AUTH_URL manquante : impossible de construire les URLs de retour." }, { status: 500 });
  // On n'encaisse pas sans documents légaux publiés ni sans CGV acceptées (version courante).
  const gate = purchasesAllowed();
  if (!gate.enabled) return NextResponse.json({ error: gate.reason }, { status: 503 });
  const accepted = await authGet<{ accepted_at: string }>(
    `SELECT accepted_at FROM terms_acceptances WHERE user_id = ? AND version = ?`, currentUser(), termsVersion(),
  );
  if (!accepted) {
    return NextResponse.json({ error: "Accepte d'abord les conditions générales de vente (version courante) pour acheter." }, { status: 403 });
  }

  const { plan } = (await readJson(req, {})) as { plan?: unknown };
  if (!isPlanKey(plan)) return NextResponse.json({ error: `Offre inconnue : « ${String(plan ?? "")} ».` }, { status: 400 });
  const spec = PLANS[plan];

  const stripe = new Stripe(key);
  const prices = await stripe.prices.list({ lookup_keys: [spec.lookupKey], active: true, limit: 1 });
  const price = prices.data[0];
  if (!price) {
    return NextResponse.json({ error: `Prix introuvable pour « ${spec.lookupKey} » (crée-le dans Stripe).` }, { status: 400 });
  }
  const userId = currentUser();
  const email = (await authGet<{ email: string | null }>(`SELECT email FROM users WHERE id = ?`, userId).catch(() => undefined))?.email ?? null;
  const session = await stripe.checkout.sessions.create(checkoutParams({ plan, priceId: price.id, userId, email }));
  return NextResponse.json({ url: session.url });
});

/** Origine canonique du site (AUTH_URL), ou null. */
function siteOrigin(): string | null {
  const raw = process.env.AUTH_URL?.trim();
  if (!raw) return null;
  try { return new URL(raw).origin; } catch { return null; }
}

/** Paramètres de la session Checkout — exposés pour être testés sans réseau. */
export function checkoutParams(o: { plan: PlanKey; priceId: string; userId: string; email?: string | null }): Stripe.Checkout.SessionCreateParams & { metadata: Record<string, string> } {
  const origin = siteOrigin();
  if (!origin) throw new Error("AUTH_URL manquante");
  const spec = PLANS[o.plan];
  const metadata: Record<string, string> = { cortexUserId: o.userId, plan: o.plan, ...(spec.credits ? { credits: String(spec.credits) } : {}) };
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
      ? { invoice_creation: { enabled: true }, customer_creation: "always" as const, payment_intent_data: { metadata } }
      // Abonnement : métadonnées aussi sur l'abonnement → une facture arrivée avant le checkout retrouve l'utilisateur.
      : { subscription_data: { metadata } }),
  };
}
