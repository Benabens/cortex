import { addTransaction, toCenti } from "@/lib/billing/credits";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook Stripe — SEUL point qui crédite un achat. Public dans proxy.ts
 * (PUBLIC_PREFIXES) car Stripe ne porte pas de session : la sécurité est la
 * SIGNATURE (STRIPE_WEBHOOK_SECRET, constructEvent sur le corps BRUT).
 * IDEMPOTENT : ref = id d'événement Stripe (unique) → un retry/double envoi
 * ne crédite jamais deux fois.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!secret || !key) return NextResponse.json({ error: "Stripe non configuré." }, { status: 501 });

  const payload = await req.text(); // corps BRUT — indispensable à la vérification
  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "Signature absente." }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = new Stripe(key).webhooks.constructEvent(payload, sig, secret);
  } catch {
    return NextResponse.json({ error: "Signature invalide." }, { status: 400 });
  }

  // `checkout.session.completed` arrive dès la fin du tunnel — pour un moyen de
  // paiement DIFFÉRÉ il porte encore `payment_status: "unpaid"`, et c'est
  // `async_payment_succeeded` qui confirme l'encaissement. Sans ce second
  // événement, le client paierait sans jamais être crédité.
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status === "paid" || session.payment_status === "no_payment_required") {
      const userId = session.metadata?.cortexUserId;
      const credits = Number(session.metadata?.credits ?? 0);
      if (userId && credits > 0) {
        const credited = await addTransaction(
          userId, toCenti(credits), `achat pack ${session.metadata?.pack ?? "?"}`, event.id,
        );
        return NextResponse.json({ ok: true, credited });
      }
      return NextResponse.json({ ok: false, error: "métadonnées manquantes" }, { status: 200 });
    }
  }
  // Autres événements : accusé de réception sans action.
  return NextResponse.json({ ok: true, ignored: event.type });
}
