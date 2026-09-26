/**
 * B8 — Webhook Stripe : achats idempotents par SESSION de paiement,
 * remboursements et litiges qui reprennent les crédits (solde négatif
 * autorisé ⇒ plus aucune génération), cohérence livemode/clé, URLs de retour
 * construites depuis AUTH_URL et jamais depuis l'en-tête Origin.
 * Hermétique : événements signés localement, zéro réseau.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-stripe-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "0";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_key_local_only";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_local";

let credits: typeof import("../lib/billing/credits");
let POST: typeof import("../app/api/billing/webhook/route").POST;
let stripe: import("stripe").default;

function signed(event: Record<string, unknown>): NextRequest {
  const payload = JSON.stringify({ object: "event", livemode: false, ...event });
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test_local" });
  return new NextRequest("http://localhost/api/billing/webhook", { method: "POST", body: payload, headers: { "stripe-signature": sig } });
}
const purchase = (eventId: string, sessionId: string, pi: string, user = "alice", credits = "5") => ({
  id: eventId, type: "checkout.session.completed",
  data: { object: { id: sessionId, object: "checkout.session", payment_status: "paid", payment_intent: pi, metadata: { cortexUserId: user, credits, pack: "medium" } } },
});

before(async () => {
  delete process.env.CORTEX_USER;
  credits = await import("../lib/billing/credits");
  ({ POST } = await import("../app/api/billing/webhook/route"));
  const Stripe = (await import("stripe")).default;
  stripe = new Stripe("sk_test_fake_key_local_only");
});

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "AUTH_URL", "STRIPE_PRICE_SMALL", "CREDITS_PACK_SMALL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("achat : idempotent par session (deux événements différents, même session → un seul crédit)", async () => {
  const r1 = await POST(signed(purchase("evt_a1", "cs_A", "pi_A")));
  assert.equal(r1.status, 200);
  assert.equal(await credits.getBalance("alice"), 5);
  const r2 = await POST(signed(purchase("evt_a2", "cs_A", "pi_A"))); // async_payment_succeeded rejoué sous un autre id
  assert.equal((await r2.json()).credited, false);
  assert.equal(await credits.getBalance("alice"), 5);
});

test("compatibilité : un achat crédité par l'ancien code (ref = id d'événement) n'est pas re-crédité", async () => {
  await credits.addTransaction("bob", 500, "achat pack medium", "evt_legacy_7"); // ligne héritée
  const r = await POST(signed(purchase("evt_legacy_7", "cs_legacy", "pi_legacy", "bob")));
  assert.equal((await r.json()).credited, false);
  assert.equal(await credits.getBalance("bob"), 5);
});

test("charge.refunded : les crédits de l'achat sont repris, le solde peut devenir négatif et bloque toute génération", async () => {
  // alice a déjà dépensé 4 des 5 crédits.
  await credits.addTransaction("alice", -400, "génération exam", "job:alice:ml:1");
  const r = await POST(signed({
    id: "evt_r1", type: "charge.refunded",
    data: { object: { id: "ch_A", object: "charge", payment_intent: "pi_A", amount: 1200, amount_refunded: 1200, refunded: true } },
  }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).reversed, true);
  assert.equal(await credits.getBalance("alice"), -4);
  const { runWithUser } = await import("../db/context");
  const gate = await runWithUser("alice", () => credits.creditsGate("assist"));
  assert.ok(gate && gate.status === 402, "solde négatif → aucune génération, même l'assistance");
});

test("charge.dispute.created sur le même achat : pas de seconde reprise ; rejeu du refund : idempotent", async () => {
  const d = await POST(signed({
    id: "evt_d1", type: "charge.dispute.created",
    data: { object: { id: "dp_A", object: "dispute", charge: "ch_A", payment_intent: "pi_A", amount: 1200 } },
  }));
  assert.equal(d.status, 200);
  assert.equal(await credits.getBalance("alice"), -4);
  await POST(signed({ id: "evt_r1bis", type: "charge.refunded", data: { object: { id: "ch_A", object: "charge", payment_intent: "pi_A", amount: 1200, amount_refunded: 1200 } } }));
  assert.equal(await credits.getBalance("alice"), -4);
});

test("litige sur un achat jamais remboursé : reprise des crédits, une seule fois", async () => {
  await POST(signed(purchase("evt_c1", "cs_C", "pi_C", "carol")));
  assert.equal(await credits.getBalance("carol"), 5);
  const d = await POST(signed({ id: "evt_d2", type: "charge.dispute.created", data: { object: { id: "dp_C", object: "dispute", payment_intent: "pi_C", amount: 1200 } } }));
  assert.equal((await d.json()).reversed, true);
  assert.equal(await credits.getBalance("carol"), 0);
});

test("livemode incohérent avec la clé (événement live, clé de test) → 400, rien crédité", async () => {
  const payload = JSON.stringify({ object: "event", livemode: true, ...purchase("evt_live", "cs_live", "pi_live", "dave") });
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test_local" });
  const r = await POST(new NextRequest("http://localhost/api/billing/webhook", { method: "POST", body: payload, headers: { "stripe-signature": sig } }));
  assert.equal(r.status, 400);
  assert.equal(await credits.getBalance("dave"), 0);
});

test("checkout : URLs de retour depuis AUTH_URL, jamais depuis Origin ; sans AUTH_URL → 500", async () => {
  const mod = await import("../app/api/billing/checkout/route");
  process.env.STRIPE_PRICE_SMALL = "price_test_small";
  process.env.CREDITS_PACK_SMALL = "1";
  delete process.env.AUTH_URL;
  const res = await mod.POST(new NextRequest("http://cortex.test/api/billing/checkout", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ pack: "small" }),
  }));
  assert.equal(res.status, 500, await res.text());
  process.env.AUTH_URL = "https://cortex.example.ch/";
  const params = mod.checkoutParams({ pack: "small", price: "price_test_small", credits: 1, userId: "alice" });
  assert.equal(params.success_url, "https://cortex.example.ch/?achat=ok");
  assert.equal(params.cancel_url, "https://cortex.example.ch/?achat=annule");
  assert.equal(params.metadata.cortexUserId, "alice");
  assert.ok(!fs.readFileSync(path.join(__dirname, "..", "app", "api", "billing", "checkout", "route.ts"), "utf8").includes('headers.get("origin")'));
});

test("clé restreinte rk_live_ : un événement live est accepté (livemode cohérent)", async () => {
  process.env.STRIPE_SECRET_KEY = "rk_live_fake_restricted_key";
  try {
    const payload = JSON.stringify({ object: "event", livemode: true, ...purchase("evt_rk", "cs_rk", "pi_rk", "erin") });
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test_local" });
    const r = await POST(new NextRequest("http://localhost/api/billing/webhook", { method: "POST", body: payload, headers: { "stripe-signature": sig } }));
    assert.equal(r.status, 200, await r.text());
    assert.equal(await credits.getBalance("erin"), 5);
  } finally { process.env.STRIPE_SECRET_KEY = "sk_test_fake_key_local_only"; }
});
