import { billingEnabled } from "@/lib/billing/credits";
import { currentUser } from "@/db/context";
import { useUser } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { readJson, withBodyLimit } from "@/lib/upload-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Achat d'un pack de crédits — Stripe Checkout (mode test d'abord : clés
 * sk_test_/prix test ; la bascule live = remplacer les clés, zéro code).
 * Le webhook (app/api/billing/webhook) créditera le solde APRÈS paiement
 * confirmé (idempotent par id d'événement) — jamais ici.
 */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  useUser(req);
  if (!billingEnabled()) {
    return NextResponse.json({ error: "Facturation désactivée (BILLING_ENABLED)." }, { status: 501 });
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return NextResponse.json({ error: "STRIPE_SECRET_KEY manquante." }, { status: 501 });

  const { pack } = (await readJson(req, ({}))) as { pack?: string };
  const p = String(pack ?? "").toLowerCase();
  const price = process.env[`STRIPE_PRICE_${p.toUpperCase()}`];
  if (!price) return NextResponse.json({ error: `Pack inconnu ou non configuré : « ${p} ».` }, { status: 400 });
  const credits = Number(process.env[`CREDITS_PACK_${p.toUpperCase()}`] ?? { small: 1, medium: 5, large: 12 }[p as "small" | "medium" | "large"] ?? 0);
  if (!credits) return NextResponse.json({ error: `Nombre de crédits non configuré pour « ${p} ».` }, { status: 400 });

  // Les URLs de retour viennent de la configuration, jamais de l'en-tête Origin
  // (contrôlé par le client : il renverrait l'acheteur vers un site tiers).
  if (!siteOrigin()) return NextResponse.json({ error: "AUTH_URL manquante : impossible de construire les URLs de retour." }, { status: 500 });
  const stripe = new Stripe(key);
  const session = await stripe.checkout.sessions.create(checkoutParams({ pack: p, price, credits, userId: currentUser() }));
  return NextResponse.json({ url: session.url });
})

/** Origine canonique du site (AUTH_URL sans barre finale), ou null. */
function siteOrigin(): string | null {
  const raw = process.env.AUTH_URL?.trim();
  if (!raw) return null;
  try { return new URL(raw).origin; } catch { return null; }
}

/** Paramètres de la session Checkout — exposés pour être testés sans réseau. */
export function checkoutParams(o: { pack: string; price: string; credits: number; userId: string }): Stripe.Checkout.SessionCreateParams & { metadata: Record<string, string> } {
  const origin = siteOrigin();
  if (!origin) throw new Error("AUTH_URL manquante");
  return {
    mode: "payment",
    line_items: [{ price: o.price, quantity: 1 }],
    success_url: `${origin}/?achat=ok`,
    cancel_url: `${origin}/?achat=annule`,
    // Le webhook lit CES métadonnées pour créditer le bon user — source de vérité.
    metadata: { cortexUserId: o.userId, credits: String(o.credits), pack: o.pack },
  };
}
