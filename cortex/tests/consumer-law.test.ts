import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
