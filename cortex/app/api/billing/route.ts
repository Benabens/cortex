import { nextRechargeDate, standingOf } from "@/lib/billing/subscription-windows";
import { requestLocale } from "@/lib/i18n/api-error";
import { errorText } from "@/lib/i18n/user-error";
import type { Locale } from "@/lib/i18n/locale";
import { billingEnabled, creditCost, fromCenti, getSubscription, listTransactions, purchasedBalanceCenti, subscriptionCreditsCenti } from "@/lib/billing/credits";
import { dailyLimit, usedToday } from "@/lib/billing/guards";
import { listOffers } from "@/lib/billing/offers";
import { contactEmail } from "@/lib/contact";
import { legalEnglishUrl, legalLinks, purchasesAllowed, type PurchasesAllowed, stripeConfigured as stripeReady, termsState } from "@/lib/legal";
import { MiB, storageQuotaBytesFor } from "@/lib/storage-quota";
import { useUser } from "@/lib/req";
import { currentUser } from "@/db/context";
import { nowStr } from "@/db/q";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function storageQuotaMb(): Promise<number | null> {
  const bytes = await storageQuotaBytesFor(currentUser());
  return bytes === null ? null : Math.floor(bytes / MiB);
}

/**
 * Solde et abonnement pour la page « Abonnement & crédits » : les deux poches
 * (achetés / abonnement du mois), l'état de l'abonnement (en règle, en cours de
 * renouvellement, impayé, suspendu), la date de recharge, l'historique et les
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
  const now = nowStr();
  const standing = standingOf(sub, now);
  const live = standing === "live";
  const terms = await termsState(currentUser());
  return NextResponse.json({
    billing: on,
    stripeConfigured,
    purchase: localizedPurchase(purchasesAllowed(), requestLocale(req)),
    legal: legalLinks(),
    legalEnglish: legalEnglishUrl(),
    contact: contactEmail(),
    terms,
    balance: on ? fromCenti(purchasedCenti + subCenti) : null,
    purchased: on ? fromCenti(purchasedCenti) : null,
    subscription: on && sub
      ? {
          status: sub.status,
          standing,
          live,
          plan: sub.plan,
          creditsThisMonth: fromCenti(subCenti),
          monthlyCredits: fromCenti(Number(sub.monthly_credits)),
          periodEnd: sub.period_end,
          cancelsAtPeriodEnd: !!Number(sub.cancel_at_period_end ?? 0),
          // Prochaine fenêtre (annuel) ou prochaine facture (mensuel) ; aucune si l'abonnement s'arrête ou n'est pas en règle.
          nextRechargeAt: live ? nextRechargeDate(sub, now) : null,
          manageable: !!sub.customer_id,
        }
      : null,
    costs: {
      exam: fromCenti(creditCost("exam")), qcm: fromCenti(creditCost("qcm")), exercise: fromCenti(creditCost("exercise")), assist: fromCenti(creditCost("assist")),
      // Ce que coûte un COURS : sa préparation, puis la relecture du format de ses annales (à la demande).
      prepare: fromCenti(creditCost("prepare")), format: fromCenti(creditCost("format")),
    },
    usedToday: { gen: await usedToday("gen"), assist: await usedToday("assist") },
    // Limites EFFECTIVES du compte (valeur posée, sinon défaut du déploiement
    // gardé ; null = levée) : l'écran les affiche au-dessus des offres.
    quotas: { gen: await dailyLimit("gen"), assist: await dailyLimit("assist") },
    storageQuotaMb: await storageQuotaMb(),
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

/** La raison d'une vente fermée, dans la langue de la requête (le code reste stable). */
function localizedPurchase(p: PurchasesAllowed, locale: Locale): PurchasesAllowed {
  return p.enabled ? p : { ...p, reason: errorText(locale, p.error) };
}
