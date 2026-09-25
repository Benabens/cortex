import { addTransaction, toCenti } from "@/lib/billing/credits";
import { authGet, authRun } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { log } from "@/lib/metrics";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook Stripe — SEUL point qui crédite un achat, et seul point qui le
 * reprend. Public dans proxy.ts (PUBLIC_PREFIXES) car Stripe ne porte pas de
 * session : la sécurité est la SIGNATURE (STRIPE_WEBHOOK_SECRET, constructEvent
 * sur le corps BRUT) + la cohérence livemode/clé.
 *
 * Achat : idempotent par SESSION de paiement (`stripe:cs:<session>`), pas par
 * événement — `completed` puis `async_payment_succeeded` décrivent le même
 * achat sous deux ids. Les lignes créditées par l'ancien code (ref = id
 * d'événement) restent reconnues.
 *
 * Reprise : `charge.refunded` et `charge.dispute.created` retirent TOUS les
 * crédits de l'achat correspondant (retrouvé par payment_intent), une seule
 * fois par achat (`stripe:reversal:<payment_intent>`), remboursement partiel
 * compris — un remboursement est une décision manuelle, re-créditer l'est
 * aussi. Le solde peut devenir négatif : plus aucune génération jusqu'au
 * prochain achat (cf. insufficient).
 */

function livemodeMatchesKey(event: Stripe.Event, key: string): boolean {
  return Boolean(event.livemode) === key.startsWith("sk_live_");
}

async function creditPurchase(session: Stripe.Checkout.Session, eventId: string): Promise<NextResponse> {
  const userId = session.metadata?.cortexUserId;
  const credits = Number(session.metadata?.credits ?? 0);
  if (!userId || !(credits > 0)) return NextResponse.json({ ok: false, error: "métadonnées manquantes" }, { status: 200 });
  const ref = `stripe:cs:${session.id}`;
  // Compatibilité : achat déjà crédité sous l'ancienne ref (id d'événement).
  const legacy = await authGet<{ id: number }>(`SELECT id FROM credit_transactions WHERE ref = ?`, eventId);
  if (legacy) return NextResponse.json({ ok: true, credited: false });
  const centi = toCenti(credits);
  const credited = await addTransaction(userId, centi, `achat pack ${session.metadata?.pack ?? "?"}`, ref);
  if (credited) {
    const pi = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
    await authRun(
      `INSERT INTO stripe_purchases (session_id, payment_intent, user_id, credits_centi, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT (session_id) DO NOTHING`,
      session.id, pi, userId, centi, nowStr(),
    ).catch((e) => log("warn", "stripe.purchase_record_failed", { message: String(e).slice(0, 200) }));
  }
  return NextResponse.json({ ok: true, credited });
}

async function reversePurchase(paymentIntent: string | null, why: string): Promise<NextResponse> {
  if (!paymentIntent) return NextResponse.json({ ok: true, reversed: false, error: "payment_intent absent" });
  const p = await authGet<{ user_id: string; credits_centi: number; session_id: string }>(
    `SELECT user_id, credits_centi, session_id FROM stripe_purchases WHERE payment_intent = ?`, paymentIntent,
  );
  if (!p) {
    log("warn", "stripe.reversal_unknown_purchase", { paymentIntent, why });
    return NextResponse.json({ ok: true, reversed: false, error: "achat inconnu" });
  }
  const reversed = await addTransaction(p.user_id, -Number(p.credits_centi), why, `stripe:reversal:${paymentIntent}`);
  return NextResponse.json({ ok: true, reversed });
}

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
  // Un événement de test sur une instance live (ou l'inverse) ne crédite rien.
  if (!livemodeMatchesKey(event, key)) {
    return NextResponse.json({ error: "livemode de l'événement incohérent avec la clé." }, { status: 400 });
  }

  // `checkout.session.completed` arrive dès la fin du tunnel — pour un moyen de
  // paiement DIFFÉRÉ il porte encore `payment_status: "unpaid"`, et c'est
  // `async_payment_succeeded` qui confirme l'encaissement.
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status === "paid" || session.payment_status === "no_payment_required") {
      return creditPurchase(session, event.id);
    }
    return NextResponse.json({ ok: true, ignored: `${event.type}:${session.payment_status}` });
  }
  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id ?? null;
    return reversePurchase(pi, "remboursement Stripe");
  }
  if (event.type === "charge.dispute.created") {
    const dispute = event.data.object as Stripe.Dispute;
    const pi = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id ?? null;
    return reversePurchase(pi, "litige Stripe");
  }
  // Autres événements : accusé de réception sans action.
  return NextResponse.json({ ok: true, ignored: event.type });
}
