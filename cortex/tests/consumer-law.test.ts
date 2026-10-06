import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-conso-"));
process.env.CORTEX_DATA_DIR = tmp;

before(async () => {
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("les deux achats recueillent des consentements juridiquement distincts", async () => {
  const { consentForPlan } = await import("../lib/consumer-law");
  assert.deepEqual(consentForPlan("credits_10"), {
    type: "pack",
    text: "Je demande l’accès immédiat à mes crédits et reconnais perdre mon droit de rétractation dès leur première utilisation.",
  });
  assert.deepEqual(consentForPlan("pro_monthly"), {
    type: "subscription",
    text: "Je demande que mon abonnement commence immédiatement. Si je me rétracte sous 14 jours, le montant proportionnel au service déjà fourni restera dû.",
  });
});

test("une demande de rétractation est reçue, datée et idempotente", async () => {
  const { authRun } = await import("../db/auth-store");
  const { createWithdrawalRequest } = await import("../lib/consumer-law");
  await authRun(`INSERT INTO users (id, email) VALUES (?,?)`, "alice", "alice@example.com");
  await authRun(`INSERT INTO stripe_purchases (session_id, payment_intent, user_id, credits_centi, created_at) VALUES (?,?,?,?,?)`, "cs_1", "pi_1", "alice", 1000, new Date().toISOString());
  const first = await createWithdrawalRequest("alice", "pack", "cs_1");
  const second = await createWithdrawalRequest("alice", "pack", "cs_1");
  assert.equal(first.status, "reçue");
  assert.match(first.requestedAt, /^\d{4}-\d{2}-\d{2}/);
  assert.equal(second.id, first.id);
});

test("une session d’abonnement abandonnée n’est pas éligible, un abonnement payé l’est une seule fois", async () => {
  const { authRun } = await import("../db/auth-store");
  const { eligibleWithdrawals } = await import("../lib/consumer-law");
  const now = new Date("2026-10-06T12:00:00Z");
  await authRun(`INSERT INTO users (id, email) VALUES (?,?)`, "subscriber", "subscriber@example.com");
  await authRun(`INSERT INTO purchase_consents (stripe_session_id, user_id, purchase_type, terms_version, consented_at) VALUES (?,?,?,?,?)`,
    "cs_abandoned", "subscriber", "subscription", "2026-10", "2026-10-05 10:00:00");
  assert.deepEqual(await eligibleWithdrawals("subscriber", now), [], "la session abandonnée n’est pas un achat");

  await authRun(`INSERT INTO subscriptions (user_id, customer_id, subscription_id, status, plan, period_start, updated_at) VALUES (?,?,?,?,?,?,?)`,
    "subscriber", "cus_paid", "sub_paid", "active", "cortex_pro_monthly", "2026-10-05 10:05:00", "2026-10-05 10:05:00");
  await authRun(`INSERT INTO purchase_consents (stripe_session_id, user_id, purchase_type, terms_version, consented_at) VALUES (?,?,?,?,?)`,
    "cs_duplicate", "subscriber", "subscription", "2026-10", "2026-10-05 10:01:00");
  assert.deepEqual(await eligibleWithdrawals("subscriber", now), [{
    id: "sub_paid", type: "subscription", purchasedAt: "2026-10-05 10:00:00", label: "Abonnement Pro",
  }]);
});

test("seul un pack live payé et non repris est éligible à la rétractation", async () => {
  const { authRun } = await import("../db/auth-store");
  const { eligibleWithdrawals } = await import("../lib/consumer-law");
  const now = new Date("2026-10-06T12:00:00Z");
  const purchasedAt = "2026-10-05 10:00:00";

  await authRun(
    `INSERT INTO stripe_purchases (session_id, payment_intent, user_id, credits_centi, livemode, created_at) VALUES (?,?,?,?,?,?)`,
    "cs_refunded", "pi_refunded", "pack-buyer", 1000, 1, purchasedAt,
  );
  await authRun(
    `INSERT INTO credit_transactions (user_id, delta, reason, ref, unit, created_at) VALUES (?,?,?,?,?,?)`,
    "pack-buyer", -1000, "remboursement Stripe", "stripe:reversal:pi_refunded", "centi", purchasedAt,
  );
  await authRun(
    `INSERT INTO stripe_purchases (session_id, payment_intent, user_id, credits_centi, livemode, created_at) VALUES (?,?,?,?,?,?)`,
    "cs_test", "pi_test", "pack-buyer", 1000, 0, purchasedAt,
  );
  await authRun(
    `INSERT INTO stripe_purchases (session_id, payment_intent, user_id, credits_centi, livemode, created_at) VALUES (?,?,?,?,?,?)`,
    "cs_disputed", "pi_disputed", "pack-buyer", 1000, 1, purchasedAt,
  );
  await authRun(
    `INSERT INTO credit_transactions (user_id, delta, reason, ref, unit, created_at) VALUES (?,?,?,?,?,?)`,
    "pack-buyer", -400, "litige Stripe", "stripe:reversal:pi_disputed:400", "centi", purchasedAt,
  );
  await authRun(
    `INSERT INTO stripe_purchases (session_id, payment_intent, user_id, credits_centi, livemode, created_at) VALUES (?,?,?,?,?,?)`,
    "cs_live", "pi_live", "pack-buyer", 1000, 1, purchasedAt,
  );

  assert.deepEqual(await eligibleWithdrawals("pack-buyer", now), [{
    id: "cs_live", type: "pack", purchasedAt, label: "Pack de 10 crédits",
  }]);
});

test("la notification éditeur utilise PUBLISHER_EMAIL et est omise sans configuration", async () => {
  const { authRun } = await import("../db/auth-store");
  const { POST } = await import("../app/api/account/withdrawal/route");
  const sent: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    sent.push(String(JSON.parse(String(init?.body)).to));
    return new Response("{}", { status: 200 });
  };
  process.env.RESEND_API_KEY = "re_test";
  process.env.PUBLISHER_EMAIL = "éditeur@example.com";
  try {
    await authRun(`INSERT INTO users (id, email) VALUES (?,?)`, "notify", "client@example.com");
    await authRun(`INSERT INTO stripe_purchases (session_id, payment_intent, user_id, credits_centi, created_at) VALUES (?,?,?,?,?)`, "cs_notify", "pi_notify", "notify", 1000, new Date().toISOString());
    const request = (user: string, purchaseId: string) => new NextRequest("http://localhost/api/account/withdrawal", {
      method: "POST", headers: { "content-type": "application/json", "x-cortex-user": user },
      body: JSON.stringify({ type: "pack", purchaseId, confirm: true }),
    });
    assert.equal((await POST(request("notify", "cs_notify"))).status, 201);
    assert.deepEqual(sent, ["client@example.com", "éditeur@example.com"]);

    sent.length = 0;
    delete process.env.PUBLISHER_EMAIL;
    await authRun(`INSERT INTO users (id, email) VALUES (?,?)`, "notify-no-publisher", "client2@example.com");
    await authRun(`INSERT INTO stripe_purchases (session_id, payment_intent, user_id, credits_centi, created_at) VALUES (?,?,?,?,?)`, "cs_notify_2", "pi_notify_2", "notify-no-publisher", 1000, new Date().toISOString());
    assert.equal((await POST(request("notify-no-publisher", "cs_notify_2"))).status, 201);
    assert.deepEqual(sent, ["client2@example.com"]);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.RESEND_API_KEY;
    delete process.env.PUBLISHER_EMAIL;
  }
});
