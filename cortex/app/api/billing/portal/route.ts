import { billingEnabled, getSubscription } from "@/lib/billing/credits";
import { useUser } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

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
  const raw = process.env.AUTH_URL?.trim();
  let origin: string | null = null;
  try { origin = raw ? new URL(raw).origin : null; } catch { origin = null; }
  if (!origin) return NextResponse.json({ error: "AUTH_URL manquante." }, { status: 500 });

  const sub = await getSubscription();
  if (!sub?.customer_id) return NextResponse.json({ error: "Aucun abonnement à gérer." }, { status: 400 });
  const stripe = new Stripe(key);
  const session = await stripe.billingPortal.sessions.create({ customer: sub.customer_id, return_url: `${origin}/compte` });
  return NextResponse.json({ url: session.url });
}
