import { billingEnabled } from "@/lib/billing/credits";
import { currentUser } from "@/db/context";
import { useUser } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Achat d'un pack de crédits — Stripe Checkout (mode test d'abord : clés
 * sk_test_/prix test ; la bascule live = remplacer les clés, zéro code).
 * Le webhook (app/api/billing/webhook) créditera le solde APRÈS paiement
 * confirmé (idempotent par id d'événement) — jamais ici.
 */
export async function POST(req: NextRequest) {
  useUser(req);
  if (!billingEnabled()) {
    return NextResponse.json({ error: "Facturation désactivée (BILLING_ENABLED)." }, { status: 501 });
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return NextResponse.json({ error: "STRIPE_SECRET_KEY manquante." }, { status: 501 });

  const { pack } = (await req.json().catch(() => ({}))) as { pack?: string };
  const p = String(pack ?? "").toLowerCase();
  const price = process.env[`STRIPE_PRICE_${p.toUpperCase()}`];
  if (!price) return NextResponse.json({ error: `Pack inconnu ou non configuré : « ${p} ».` }, { status: 400 });
  const credits = Number(process.env[`CREDITS_PACK_${p.toUpperCase()}`] ?? { small: 1, medium: 5, large: 12 }[p as "small" | "medium" | "large"] ?? 0);
  if (!credits) return NextResponse.json({ error: `Nombre de crédits non configuré pour « ${p} ».` }, { status: 400 });

  const origin = req.headers.get("origin") ?? process.env.AUTH_URL ?? new URL(req.url).origin;
  const stripe = new Stripe(key);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price, quantity: 1 }],
    success_url: `${origin}/?achat=ok`,
    cancel_url: `${origin}/?achat=annule`,
    // Le webhook lit CES métadonnées pour créditer le bon user — source de vérité.
    metadata: { cortexUserId: currentUser(), credits: String(credits), pack: p },
  });
  return NextResponse.json({ url: session.url });
}
