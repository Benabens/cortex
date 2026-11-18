import { apiError } from "@/lib/i18n/api-error";
import { billingEnabled, getSubscription } from "@/lib/billing/credits";
import { isPlanKey, PLANS } from "@/lib/billing/stripe-events";
import { secondSubscriptionRefusal, standingOf } from "@/lib/billing/subscription-windows";
import { authGet } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { purchasesAllowed, termsState } from "@/lib/legal";
import { currentUser } from "@/db/context";
import { useUser } from "@/lib/req";
import { readJson, withBodyLimit } from "@/lib/upload-limit";
import { NextRequest, NextResponse } from "next/server";
import { stripeClient } from "@/lib/billing/stripe-client";
import { openCheckout } from "@/lib/billing/checkout-session";
import { publicOrigin } from "@/lib/public-url";
import { consentForPlan, recordPurchaseConsent } from "@/lib/consumer-law";

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
    return apiError(req, "billing_disabled", 501);
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return apiError(req, "stripe_secret_key_missing", 501);
  if (!publicOrigin()) return apiError(req, "auth_url_missing_checkout", 500);
  // On n'encaisse pas sans documents légaux publiés ni sans CGV acceptées (version courante).
  const gate = purchasesAllowed();
  if (!gate.enabled) return apiError(req, gate.error, 503);
  const terms = await termsState(currentUser());
  if (!terms.accepted) {
    return apiError(req, "terms_acceptance_required", 403);
  }
  const { plan, consent } = (await readJson(req, {})) as { plan?: unknown; consent?: unknown };
  if (!isPlanKey(plan)) return apiError(req, { code: "plan_unknown", params: { plan: String(plan ?? "") } }, 400);
  if (consent !== true) {
    const kind = consentForPlan(plan).type;
    return apiError(req, kind === "pack" ? "pack_consent_required" : "subscription_consent_required", 400);
  }
  const spec = PLANS[plan];

  // UN SEUL abonnement par compte, vérifié ICI : la table `subscriptions` a le
  // compte pour clé primaire, donc un second abonnement écraserait la ligne du
  // premier — qui continuerait de facturer sans que l'app le sache. Le bouton
  // désactivé côté écran ne suffit pas (deux onglets, un POST direct). La garde
  // suit l'état de l'abonnement chez Stripe, pas la présence de crédits : en
  // retard de paiement ou en cours de renouvellement, il facture toujours. Avant le premier
  // webhook, c'est openCheckout qui garde (verrou par compte, abonnements lus chez Stripe).
  const userId = currentUser();
  if (spec.mode === "subscription") {
    const refusal = secondSubscriptionRefusal(standingOf(await getSubscription(userId), nowStr()));
    if (refusal) return apiError(req, refusal, 409);
  }

  const stripe = stripeClient(key);
  const prices = await stripe.prices.list({ lookup_keys: [spec.lookupKey], active: true, limit: 1 });
  const price = prices.data[0];
  if (!price) {
    return apiError(req, { code: "stripe_price_not_found", params: { lookupKey: spec.lookupKey } }, 400);
  }
  const email = (await authGet<{ email: string | null }>(`SELECT email FROM users WHERE id = ?`, userId).catch(() => undefined))?.email ?? null;
  // Client Stripe unique, un seul Checkout d'abonnement ouvert, état réel chez Stripe (lib/billing/checkout-session).
  const session = await openCheckout({ stripe, userId, plan, priceId: price.id, email });
  if (!session.ok) return apiError(req, session, session.status);
  try {
    await recordPurchaseConsent({ userId, plan, termsVersion: terms.version, stripeSessionId: session.sessionId });
  } catch (error) {
    await stripe.checkout.sessions.expire(session.sessionId).catch(() => undefined);
    throw error;
  }
  return NextResponse.json({ url: session.url });
});
