/**
 * Crédits + Stripe — hermétique, zéro réseau :
 *  - palier gratuit crédité UNE fois ; solde = somme des transactions ;
 *  - débit par génération + remboursement seulement-si-débité, idempotents ;
 *  - gate 402 quand le solde est insuffisant ;
 *  - quotas quotidiens (gen/assist) ;
 *  - WEBHOOK STRIPE : événement signé LOCALEMENT (generateTestHeaderString),
 *    crédit au 1er passage, REJOUÉ → pas de double crédit (idempotence par
 *    event.id), signature invalide → 400.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-credits-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "2";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_key_local_only";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_local";

let credits: typeof import("../lib/billing/credits");
let guards: typeof import("../lib/billing/guards");
let webhookPOST: typeof import("../app/api/billing/webhook/route").POST;

before(async () => {
  delete process.env.DAILY_GEN_QUOTA;
  delete process.env.DAILY_ASSIST_QUOTA;
  credits = await import("../lib/billing/credits");
  guards = await import("../lib/billing/guards");
  ({ POST: webhookPOST } = await import("../app/api/billing/webhook/route"));
});

after(() => {
  for (const k of ["BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "DAILY_GEN_QUOTA", "DAILY_ASSIST_QUOTA", "CORTEX_DATA_DIR"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("palier gratuit : crédité UNE fois (idempotent), solde = somme des transactions", async () => {
  assert.equal(await credits.getBalance("owner"), 2);
  assert.equal(await credits.getBalance("owner"), 2); // 2e lecture : pas re-crédité
});

test("débit / remboursement : idempotents, remboursement seulement si débit", async () => {
  await credits.debitGeneration("exam", "job:ml:1"); // exam = 2 crédits
  assert.equal(await credits.getBalance("owner"), 0);
  await credits.debitGeneration("exam", "job:ml:1"); // rejoué → no-op (ref unique)
  assert.equal(await credits.getBalance("owner"), 0);

  await credits.refundGeneration("exam", "job:ml:1", "owner");
  assert.equal(await credits.getBalance("owner"), 2);
  await credits.refundGeneration("exam", "job:ml:1", "owner"); // rejoué → no-op
  assert.equal(await credits.getBalance("owner"), 2);
  // remboursement d'un job JAMAIS débité → no-op
  await credits.refundGeneration("exam", "job:ml:999", "owner");
  assert.equal(await credits.getBalance("owner"), 2);
});

test("creditsGate : passe avec solde, 402 clair sans solde ; billing off → no-op", async () => {
  assert.equal(await credits.creditsGate("qcm"), null); // solde 2 ≥ 1
  await credits.debitGeneration("exam", "job:ml:2"); // → 0
  const gate = await credits.creditsGate("exam");
  assert.ok(gate && gate.status === 402 && /Solde insuffisant/.test(gate.error));

  process.env.BILLING_ENABLED = "0";
  assert.equal(await credits.creditsGate("exam"), null);
  process.env.BILLING_ENABLED = "1";
});

test("quotas quotidiens : sans env → passe ; cap atteint → 429", async () => {
  assert.equal(await guards.generationGate("gen"), null);
  process.env.DAILY_GEN_QUOTA = "2";
  await guards.recordGeneration("gen", "exam");
  await guards.recordGeneration("gen", "qcm");
  const gate = await guards.generationGate("gen");
  assert.ok(gate && gate.status === 429 && /Quota quotidien/.test(gate.error));
  // le bucket assist est indépendant
  assert.equal(await guards.generationGate("assist"), null);
  delete process.env.DAILY_GEN_QUOTA;
});

test("webhook Stripe : crédit au 1er passage, PAS de double crédit au rejeu, signature invalide → 400", async () => {
  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe("sk_test_fake_key_local_only");
  const payload = JSON.stringify({
    id: "evt_test_0001",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1", object: "checkout.session", payment_status: "paid",
        metadata: { cortexUserId: "alice", credits: "5", pack: "medium" },
      },
    },
  });
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test_local" });
  const { NextRequest } = await import("next/server");
  const mk = (body: string, signature: string) =>
    new NextRequest("http://localhost/api/billing/webhook", {
      method: "POST", body, headers: { "stripe-signature": signature },
    });

  const before5 = await credits.getBalance("alice"); // 2 (signup)
  const res1 = await webhookPOST(mk(payload, sig));
  assert.equal(res1.status, 200);
  assert.equal((await res1.json()).credited, true);
  assert.equal(await credits.getBalance("alice"), before5 + 5);

  // REJEU du même événement (retry Stripe) → aucun double crédit
  const res2 = await webhookPOST(mk(payload, sig));
  assert.equal((await res2.json()).credited, false);
  assert.equal(await credits.getBalance("alice"), before5 + 5);

  // Signature invalide → 400, rien crédité
  const res3 = await webhookPOST(mk(payload, "t=1,v1=deadbeef"));
  assert.equal(res3.status, 400);
  assert.equal(await credits.getBalance("alice"), before5 + 5);
});
