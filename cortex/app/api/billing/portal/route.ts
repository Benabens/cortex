import { billingEnabled, getSubscription } from "@/lib/billing/credits";
import { useUser } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";
import { stripeClient } from "@/lib/billing/stripe-client";
import { findPortalConfiguration } from "@/lib/billing/stripe-setup";
import { publicOrigin } from "@/lib/public-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Portail client Stripe — gérer / résilier l'abonnement (résiliation en fin de
 * période ; les crédits du mois restent utilisables jusque-là). L'URL de retour
 * vient d'AUTH_URL, jamais de l'en-tête Origin.
 */
export async function POST(req: NextRequest) {
  useUser(req);
  if (!billingEnabled()) return NextResponse.json({ error: "Facturation désactivée (BILLING_ENABLED)." }, { status: 501 });
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return NextResponse.json({ error: "STRIPE_SECRET_KEY manquante." }, { status: 501 });
  const origin = publicOrigin();
  if (!origin) return NextResponse.json({ error: "AUTH_URL manquante." }, { status: 500 });

  const sub = await getSubscription();
  if (!sub?.customer_id) return NextResponse.json({ error: "Aucun abonnement à gérer." }, { status: 400 });
  const stripe = stripeClient(key);
  // La configuration de portail PROPRE à Cortex si elle existe (compte Stripe
  // partagé : celle par défaut du compte n'est pas forcément la nôtre, et peut
  // ne pas exister en live). Introuvable ou illisible : celle du compte.
  const configuration = await findPortalConfiguration(stripe).catch(() => null);
  const session = await stripe.billingPortal.sessions.create({
    customer: sub.customer_id, return_url: `${origin}/compte`, ...(configuration ? { configuration } : {}),
  });
  return NextResponse.json({ url: session.url });
}
