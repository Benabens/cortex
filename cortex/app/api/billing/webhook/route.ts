import { apiError } from "@/lib/i18n/api-error";
import { handleStripeEvent } from "@/lib/billing/stripe-events";
import { readText, withBodyLimit } from "@/lib/upload-limit";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { stripeClient } from "@/lib/billing/stripe-client";
import { captureError, captureErrorThrottled } from "@/lib/observability";

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

/** En-tête de la forme de Stripe (`t=<horodatage récent>,v1=<64 hex>`) : un envoi réel, pas un robot. */
function looksSentByStripe(sig: string): boolean {
  const t = Number(/(?:^|,)t=(\d+)/.exec(sig)?.[1]);
  return /(?:^|,)v1=[0-9a-f]{64}(?:,|$)/.test(sig) && Math.abs(Date.now() / 1000 - t) <= 300;
}

export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!secret || !key) return apiError(req, "stripe_not_configured", 501);

  const payload = await readText(req); // corps BRUT — indispensable à la vérification
  const sig = req.headers.get("stripe-signature");
  if (!sig) return apiError(req, "stripe_signature_missing", 400);

  let event: Stripe.Event;
  const stripe = stripeClient(key);
  try {
    event = stripe.webhooks.constructEvent(payload, sig, secret);
  } catch {
    // Secret tourné ou mauvais endpoint : Stripe réessaie 3 jours puis abandonne, les paiements
    // ne créditent plus. Rien du corps (non vérifié) dans l'alerte ; une par heure au plus, et
    // seulement pour un en-tête qui a la forme d'un envoi de Stripe (un robot ne la noie pas).
    if (looksSentByStripe(sig)) {
      captureErrorThrottled("billing.webhook_signature", new Error("Webhook Stripe : signature invalide (STRIPE_WEBHOOK_SECRET ?)"), { area: "billing", step: "webhook_signature" });
    }
    return apiError(req, "stripe_signature_invalid", 400);
  }
  if (!livemodeMatchesKey(event, key)) {
    captureErrorThrottled("billing.webhook_livemode", new Error("Webhook Stripe : livemode de l'événement incohérent avec la clé"), { area: "billing", step: "webhook_livemode", event_type: event.type });
    return apiError(req, "stripe_livemode_mismatch", 400);
  }

  try {
    const res = await handleStripeEvent(event, {
      // Achat absent de stripe_purchases (antérieur à l'enregistrement) : Stripe sait quelle session porte ce paiement.
      lookup: {
        async sessionByPaymentIntent(pi) {
          const r = await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 });
          const s = r.data[0];
          if (!s) return null;
          const credits = Number(s.metadata?.credits ?? 0);
          return { id: s.id, userId: s.metadata?.cortexUserId ?? null, credits: credits > 0 ? credits : null };
        },
        // Format récent : la facture ne porte que l'id du prix → lookup_key via le cache des prix Cortex.
        async lookupKeyOfPrice(priceId) {
          const { lookupKeyOfPriceId } = await import("@/lib/billing/offers");
          return lookupKeyOfPriceId(priceId);
        },
        // Format récent : la charge ne porte plus `invoice` → InvoicePayments par payment_intent.
        async invoiceByPaymentIntent(pi) {
          const r = await stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: pi }, limit: 1 });
          const inv = r.data[0]?.invoice;
          const id = typeof inv === "string" ? inv : inv?.id;
          return id ? { invoiceId: id } : null;
        },
        // Revenu net : frais réels du paiement (balance transaction de sa charge).
        async paymentDetails(pi) {
          const { feeOfPaymentIntent } = await import("@/lib/billing/stripe-fees");
          return { feeCents: await feeOfPaymentIntent(stripe, pi) };
        },
      },
    });
    // 200 = accusé (traité, doublon, ou échec PERMANENT type métadonnées
    // manquantes). Les échecs RETRYABLES lèvent → 500 → Stripe réessaie.
    return NextResponse.json(res, { status: 200 });
  } catch (e) {
    // Stripe réessaie pendant 3 jours, puis abandonne : un paiement non crédité doit se voir
    // avant. Étiquettes techniques seulement ; un id Stripe cité par le message est masqué (redactMessage).
    captureError(e, { area: "billing", step: "webhook", event_type: event.type });
    return apiError(req, "stripe_webhook_processing_failed", 500);
  }
});
