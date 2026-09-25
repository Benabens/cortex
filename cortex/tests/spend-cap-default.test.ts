/**
 * I7 — SPEND_CAP_USD (plafond global de dépense) a un défaut FAIL-CLOSED dès
 * que l'instance est gardée (auth ou facturation) : un oubli de variable ne
 * doit pas laisser la dépense sans borne. Dev €0 nu : pas de plafond.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

const KEYS = ["SPEND_CAP_USD", "AUTH_ENABLED", "BILLING_ENABLED"];
after(() => { for (const k of KEYS) delete process.env[k]; });

test("déploiement gardé sans SPEND_CAP_USD → 50 $ par défaut ; « unlimited » lève explicitement", async () => {
  const usage = await import("../lib/billing/usage");
  for (const k of KEYS) delete process.env[k];
  assert.equal(usage.spendCapUsd(), null, "dev €0 nu : pas de plafond");
  process.env.AUTH_ENABLED = "1";
  assert.equal(usage.spendCapUsd(), 50);
  delete process.env.AUTH_ENABLED;
  process.env.BILLING_ENABLED = "1";
  assert.equal(usage.spendCapUsd(), 50);
  process.env.SPEND_CAP_USD = "unlimited";
  assert.equal(usage.spendCapUsd(), null);
  process.env.SPEND_CAP_USD = "0";
  assert.equal(usage.spendCapUsd(), 0, "0 reste le kill-switch total");
  process.env.SPEND_CAP_USD = "n'importe quoi";
  assert.equal(usage.spendCapUsd(), 50, "valeur invalide → défaut, jamais une levée par faute de frappe");
});
