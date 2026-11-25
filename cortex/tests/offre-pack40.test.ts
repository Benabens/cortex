/**
 * Offre du 25/11/2026 : pack de 40 crédits (36 €) à côté du pack de 10, Pro à 30 crédits par mois.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("Pro : 30 crédits par mois par défaut, SUBSCRIPTION_MONTHLY_CREDITS prime", async () => {
  const { subscriptionMonthlyCreditsCenti } = await import("../lib/billing/credits");
  const saved = process.env.SUBSCRIPTION_MONTHLY_CREDITS;
  delete process.env.SUBSCRIPTION_MONTHLY_CREDITS;
  try {
    assert.equal(subscriptionMonthlyCreditsCenti(), 3000);
    process.env.SUBSCRIPTION_MONTHLY_CREDITS = "20";
    assert.equal(subscriptionMonthlyCreditsCenti(), 2000);
  } finally {
    if (saved === undefined) delete process.env.SUBSCRIPTION_MONTHLY_CREDITS;
    else process.env.SUBSCRIPTION_MONTHLY_CREDITS = saved;
  }
});

test("plan credits_40 : lookup_key cortex_credits_40, paiement unique de 40 crédits, même prix du crédit que le pack de 10", async () => {
  const { PLANS, planOfLookupKey } = await import("../lib/billing/stripe-events");
  assert.deepEqual(PLANS.credits_40, { lookupKey: "cortex_credits_40", mode: "payment", credits: 40, label: "Pack de 40 crédits" });
  assert.equal(planOfLookupKey("cortex_credits_40"), "credits_40");
  const { OFFERS } = await import("../lib/billing/stripe-setup");
  const cents = (k: string) => OFFERS.find((o) => o.lookupKey === k)!.unitAmount;
  assert.equal(cents("cortex_credits_40"), 3600);
  assert.equal(cents("cortex_credits_40") / 40, cents("cortex_credits_10") / 10, "0,90 € le crédit dans les deux packs");
});

test("offres : le pack de 40 est listé avec son prix ; absent de Stripe, il est caché ; sans aucun prix, tout reste affiché", async () => {
  const { offersFrom } = await import("../lib/billing/offers");
  const eur = (amount: number) => ({ amount, currency: "EUR" });
  const all = offersFrom({ cortex_pro_monthly: eur(14.9), cortex_pro_yearly: eur(149), cortex_credits_40: eur(36), cortex_credits_10: eur(9) }, 30);
  assert.deepEqual(all.map((o) => [o.plan, o.credits, o.price?.amount]), [["pro_monthly", 30, 14.9], ["pro_yearly", 30, 149], ["credits_40", 40, 36], ["credits_10", 10, 9]]);
  const before = offersFrom({ cortex_pro_monthly: eur(14.9), cortex_pro_yearly: eur(149), cortex_credits_10: eur(9) }, 30);
  assert.deepEqual(before.map((o) => o.plan), ["pro_monthly", "pro_yearly", "credits_10"], "pas d'offre impossible à acheter");
  assert.deepEqual(offersFrom({}, 30).map((o) => [o.plan, o.price]), [["pro_monthly", null], ["pro_yearly", null], ["credits_40", null], ["credits_10", null]]);
});
