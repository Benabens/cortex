/**
 * ACHATS ET CLÉ STRIPE DE TEST. Une clé de test accepte les cartes de test
 * (4242…) : sur une instance de production ouverte à tous, n'importe qui
 * « paierait » sans payer et recevrait de vrais crédits. La vente n'ouvre donc
 * en production publique qu'avec une clé LIVE ; une clé de test reste utilisable
 * hors production (dev, staging) et en lancement fermé (INVITE_ONLY=1), où
 * seuls les invités peuvent se connecter.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

const LEGAL = { LEGAL_TERMS_URL: "https://l.example/terms", LEGAL_PRIVACY_URL: "https://l.example/privacy", LEGAL_REFUND_URL: "https://l.example/remboursement", LEGAL_NOTICE_URL: "https://l.example/mentions-legales" };
const env = (over: Record<string, string | undefined>) => ({ NODE_ENV: "production", STRIPE_WEBHOOK_SECRET: "whsec_x", ...LEGAL, ...over }) as Partial<NodeJS.ProcessEnv>;

before(() => { process.env.BILLING_ENABLED = "1"; });
after(() => { delete process.env.BILLING_ENABLED; });

test("production ouverte au public + clé de test : achats fermés, avec une raison lisible", async () => {
  const { purchasesAllowed } = await import("../lib/legal");
  for (const key of ["sk_test_abc", "rk_test_abc"]) {
    const r = purchasesAllowed(env({ STRIPE_SECRET_KEY: key }));
    assert.equal(r.enabled, false, key);
    assert.match(r.reason ?? "", /bientôt/);
  }
  assert.equal(purchasesAllowed(env({ STRIPE_SECRET_KEY: "sk_test_abc", INVITE_ONLY: "0" })).enabled, false, "INVITE_ONLY=0 n'est pas un lancement fermé");
});

test("production + clé live : achats ouverts", async () => {
  const { purchasesAllowed } = await import("../lib/legal");
  for (const key of ["sk_live_abc", "rk_live_abc"]) {
    assert.deepEqual(purchasesAllowed(env({ STRIPE_SECRET_KEY: key })), { enabled: true, reason: null }, key);
  }
});

test("clé de test : toujours utilisable en lancement fermé et hors production", async () => {
  const { purchasesAllowed } = await import("../lib/legal");
  assert.equal(purchasesAllowed(env({ STRIPE_SECRET_KEY: "sk_test_abc", INVITE_ONLY: "1" })).enabled, true, "lancement fermé : seuls les invités achètent en test");
  assert.equal(purchasesAllowed(env({ STRIPE_SECRET_KEY: "sk_test_abc", NODE_ENV: "development" })).enabled, true, "poste de dev");
});
