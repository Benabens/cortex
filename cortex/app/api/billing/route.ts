import { nextRechargeDate } from "@/lib/billing/subscription-windows";
import { billingEnabled, creditCost, fromCenti, getSubscription, listTransactions, purchasedBalanceCenti, subscriptionCreditsCenti, subscriptionLive } from "@/lib/billing/credits";
import { usedToday } from "@/lib/billing/guards";
import { listOffers } from "@/lib/billing/offers";
import { legalLinks, purchasesAllowed, stripeConfigured as stripeReady, termsState } from "@/lib/legal";
import { useUser } from "@/lib/req";
import { currentUser } from "@/db/context";
import { nowStr } from "@/db/q";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Premier jour du mois suivant (UTC) — date de la prochaine recharge des crédits d'abonnement. */

/**
 * Solde et abonnement pour la page « Abonnement & crédits » : les deux poches
 * (achetés / abonnement du mois), la date de recharge, l'historique et les
 * offres avec leur prix Stripe. Tout est exprimé en CRÉDITS (le ledger compte
 * en centièmes). Sans facturation : structure identique, valeurs nulles.
 */
export async function GET(req: NextRequest) {
  useUser(req);
  const on = billingEnabled();
  const stripeConfigured = stripeReady();
  const sub = on ? await getSubscription() : undefined;
  const subCenti = on ? await subscriptionCreditsCenti() : 0;
  const purchasedCenti = on ? await purchasedBalanceCenti() : 0;
  const live = subscriptionLive(sub);
  const terms = await termsState(currentUser());
  return NextResponse.json({
    billing: on,
    stripeConfigured,
    purchase: purchasesAllowed(),
    legal: legalLinks(),
    terms,
    balance: on ? fromCenti(purchasedCenti + subCenti) : null,
    purchased: on ? fromCenti(purchasedCenti) : null,
    subscription: on && sub
      ? {
          status: sub.status,
          live,
          plan: sub.plan,
          creditsThisMonth: fromCenti(subCenti),
          monthlyCredits: fromCenti(Number(sub.monthly_credits)),
          periodEnd: sub.period_end,
          // Recharge au 1er du mois suivant tant que la période court (et hors résiliation) ; sinon plus de recharge.
          nextRechargeAt: live ? nextRechargeDate(sub, nowStr()) : null,
          manageable: !!sub.customer_id,
        }
      : null,
    costs: { exam: fromCenti(creditCost("exam")), qcm: fromCenti(creditCost("qcm")), exercise: fromCenti(creditCost("exercise")), assist: fromCenti(creditCost("assist")) },
    usedToday: { gen: await usedToday("gen"), assist: await usedToday("assist") },
    quotas: {
      gen: process.env.DAILY_GEN_QUOTA ? Number(process.env.DAILY_GEN_QUOTA) : null,
      assist: process.env.DAILY_ASSIST_QUOTA ? Number(process.env.DAILY_ASSIST_QUOTA) : null,
    },
    transactions: on
      ? (await listTransactions()).map((t) => ({
          ...t,
          delta: fromCenti(Number(t.delta)),
          subAmount: fromCenti(Number((t as { sub_amount?: number }).sub_amount ?? 0)),
        }))
      : [],
    offers: on ? await listOffers() : [],
  });
}
