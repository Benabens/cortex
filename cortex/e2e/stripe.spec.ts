import { test, expect } from "@playwright/test";
import Stripe from "stripe";
import { loginPersona } from "./helpers";

/**
 * Boucle Stripe RÉELLE en mode test, en local (jamais en CI, jamais en live) :
 * Checkout payé avec la carte 4242 → checkout.session.completed → +10 crédits
 * → remboursement → charge.refunded → crédits repris.
 *
 * Les événements viennent de Stripe par `stripe listen` (signature vérifiée par
 * la vraie route webhook). Lancement : bash scripts/stripe-test-boucle.sh, qui
 * démarre `stripe listen`, pose STRIPE_WEBHOOK_SECRET et ouvre la vente locale
 * (LANDING_URL + INVITE_ONLY) avant d'appeler Playwright.
 */
const key = process.env.STRIPE_SECRET_KEY ?? "";
const configured = key.startsWith("sk_test_") && !!process.env.STRIPE_WEBHOOK_SECRET && process.env.E2E_STRIPE_LISTEN === "1";
test.skip(!configured, "Boucle Stripe locale : lancer scripts/stripe-test-boucle.sh (clé sk_test_ + stripe listen).");

test("pack payé par carte de test, crédité par le webhook, puis remboursé et repris @stripe", async ({ page }) => {
  test.setTimeout(180_000);
  expect(key.startsWith("sk_test_"), "jamais une clé live").toBeTruthy();
  const stripe = new Stripe(key);
  const persona = `buyer${Date.now()}`;
  await loginPersona(page, persona);

  const balance = async () => {
    const r = await page.request.get("/api/billing");
    expect(r.ok(), await r.text()).toBeTruthy();
    return Number((await r.json()).balance);
  };
  expect(await balance()).toBe(0);

  const billing = await (await page.request.get("/api/billing")).json();
  expect(billing.purchase?.enabled, JSON.stringify(billing.purchase)).toBe(true);
  expect((await page.request.post("/api/billing/terms", { data: { version: billing.terms.version } })).ok()).toBeTruthy();

  const checkout = await page.request.post("/api/billing/checkout", { data: { plan: "credits_10", consent: true } });
  expect(checkout.ok(), await checkout.text()).toBeTruthy();
  const url = String((await checkout.json()).url);
  const sessionId = url.match(/cs_test_[A-Za-z0-9]+/)?.[0];
  expect(sessionId, url).toBeTruthy();
  const created = await stripe.checkout.sessions.retrieve(sessionId!);
  expect(created.livemode).toBe(false);

  // Page Checkout hébergée par Stripe, carte de test.
  await page.goto(url);
  // Le formulaire Checkout vit dans l'iframe Elements « habanero » (page hébergée de 2026) :
  // choix du moyen, champs de carte et bouton de paiement y sont tous.
  const f = page.frameLocator('iframe[src*="elements-inner-habanero"]');
  const pay = f.getByTestId("payment-form-submit-button");
  await expect(pay).toBeVisible({ timeout: 30_000 });
  const number = f.locator("#payment-numberInput");
  // Plusieurs moyens activés : la carte est un choix d'accordéon à ouvrir.
  if (!(await number.isVisible())) await f.getByText(/^(Card|Carte)$/).first().click();
  await expect(number).toBeVisible({ timeout: 15_000 });
  await number.fill("4242 4242 4242 4242");
  await f.locator("#payment-expiryInput").fill("12 / 34");
  await f.locator("#payment-cvcInput").fill("123");
  const holder = f.locator("#payment-nameInput");
  if (await holder.isVisible().catch(() => false)) await holder.fill("Test Cortex");
  // Ne pas créer de compte Link pour la persona.
  const link = f.locator("#payment-linkOptInInput");
  if (await link.isChecked().catch(() => false)) await link.uncheck();
  await pay.click();
  await expect(page).toHaveURL(/\/compte\?achat=ok/, { timeout: 90_000 });

  // checkout.session.completed → webhook → +10 (permanents).
  await expect.poll(balance, { timeout: 60_000, intervals: [1000] }).toBe(10);
  const paid = await stripe.checkout.sessions.retrieve(sessionId!);
  expect(paid.payment_status).toBe("paid");
  const pi = typeof paid.payment_intent === "string" ? paid.payment_intent : paid.payment_intent?.id;
  expect(pi).toBeTruthy();

  // Remboursement complet → charge.refunded → crédits repris.
  const refund = await stripe.refunds.create({ payment_intent: pi! });
  expect(refund.status).toMatch(/succeeded|pending/);
  await expect.poll(balance, { timeout: 60_000, intervals: [1000] }).toBe(0);
});
