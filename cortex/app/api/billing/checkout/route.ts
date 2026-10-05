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
import { checkoutParams, siteOrigin } from "@/lib/billing/checkout-params";
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
    return NextResponse.json({ error: "Facturation désactivée (BILLING_ENABLED)." }, { status: 501 });
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return NextResponse.json({ error: "STRIPE_SECRET_KEY manquante." }, { status: 501 });
  if (!siteOrigin()) return NextResponse.json({ error: "AUTH_URL manquante : impossible de construire les URLs de retour." }, { status: 500 });
  // On n'encaisse pas sans documents légaux publiés ni sans CGV acceptées (version courante).
  const gate = purchasesAllowed();
  if (!gate.enabled) return NextResponse.json({ error: gate.reason }, { status: 503 });
  const terms = await termsState(currentUser());
  if (!terms.accepted) {
    return NextResponse.json({ error: "Accepte d'abord les conditions générales de vente (version courante) pour acheter." }, { status: 403 });
  }
  const { plan, consent } = (await readJson(req, {})) as { plan?: unknown; consent?: unknown };
  if (!isPlanKey(plan)) return NextResponse.json({ error: `Offre inconnue : « ${String(plan ?? "")} ».` }, { status: 400 });
  if (consent !== true) {
    const kind = consentForPlan(plan).type;
    return NextResponse.json({ error: kind === "pack"
      ? "Confirme l’accès immédiat aux crédits et la perte du droit de rétractation dès leur première utilisation."
      : "Confirme le démarrage immédiat de l’abonnement et le paiement proportionnel du service fourni en cas de rétractation." }, { status: 400 });
  }
  const spec = PLANS[plan];

  // UN SEUL abonnement par compte, vérifié ICI : la table `subscriptions` a le
  // compte pour clé primaire, donc un second abonnement écraserait la ligne du
  // premier — qui continuerait de facturer sans que l'app le sache. Le bouton
  // désactivé côté écran ne suffit pas (deux onglets, un POST direct). La garde
  // suit l'état de l'abonnement chez Stripe, pas la présence de crédits : en
  // retard de paiement ou en cours de renouvellement, il facture toujours.
  const userId = currentUser();
  if (spec.mode === "subscription") {
    const refusal = secondSubscriptionRefusal(standingOf(await getSubscription(userId), nowStr()));
    if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });
  }

  const stripe = stripeClient(key);
  const prices = await stripe.prices.list({ lookup_keys: [spec.lookupKey], active: true, limit: 1 });
  const price = prices.data[0];
  if (!price) {
    return NextResponse.json({ error: `Prix introuvable pour « ${spec.lookupKey} » (crée-le dans Stripe).` }, { status: 400 });
  }
  const email = (await authGet<{ email: string | null }>(`SELECT email FROM users WHERE id = ?`, userId).catch(() => undefined))?.email ?? null;
  const session = await stripe.checkout.sessions.create(checkoutParams({ plan, priceId: price.id, userId, email }));
  try {
    await recordPurchaseConsent({ userId, plan, termsVersion: terms.version, stripeSessionId: session.id });
  } catch (error) {
    await stripe.checkout.sessions.expire(session.id).catch(() => undefined);
    throw error;
  }
  return NextResponse.json({ url: session.url });
});
