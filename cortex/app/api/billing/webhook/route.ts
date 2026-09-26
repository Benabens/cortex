import { handleStripeEvent } from "@/lib/billing/stripe-events";
import { readText, withBodyLimit } from "@/lib/upload-limit";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook Stripe — SEUL point qui crédite, attribue ou reprend. Public dans
 * proxy.ts (Stripe ne porte pas de session) : la sécurité est la SIGNATURE
 * (STRIPE_WEBHOOK_SECRET, constructEvent sur le corps BRUT) et la cohérence
 * livemode/clé. Le traitement et l'idempotence sont dans lib/billing/stripe-events.
 */

function livemodeMatchesKey(event: Stripe.Event, key: string): boolean {
  return Boolean(event.livemode) === /^(sk|rk)_live_/.test(key); // clés secrètes et restreintes
}

export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!secret || !key) return NextResponse.json({ error: "Stripe non configuré." }, { status: 501 });

  const payload = await readText(req); // corps BRUT — indispensable à la vérification
  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "Signature absente." }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = new Stripe(key).webhooks.constructEvent(payload, sig, secret);
  } catch {
    return NextResponse.json({ error: "Signature invalide." }, { status: 400 });
  }
  if (!livemodeMatchesKey(event, key)) {
    return NextResponse.json({ error: "livemode de l'événement incohérent avec la clé." }, { status: 400 });
  }

  try {
    const res = await handleStripeEvent(event);
    // 200 = accusé (traité, doublon, ou échec PERMANENT type métadonnées
    // manquantes). Les échecs RETRYABLES lèvent → 500 → Stripe réessaie.
    return NextResponse.json(res, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message.slice(0, 200) : "Erreur de traitement." }, { status: 500 });
  }
});
