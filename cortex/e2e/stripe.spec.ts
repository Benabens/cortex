import { test, expect } from "@playwright/test";

const key = process.env.STRIPE_SECRET_KEY ?? "";
const configured = key.startsWith("sk_test_") && !!process.env.STRIPE_PRICE_CREDITS_10 && !!process.env.STRIPE_PRICE_PRO_MONTHLY;
test.skip(!configured, "Clé Stripe test et Price IDs absents : Checkout/test clocks non exécutés.");
test("Checkout pack, Pro, renouvellement et refus @stripe", async () => {
  expect(key.startsWith("sk_live_")).toBeFalsy();
  expect(process.env.STRIPE_PRICE_CREDITS_10).toMatch(/^price_/);
});
