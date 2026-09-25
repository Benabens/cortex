import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * I9 — Le lien magique par e-mail est une seconde voie d'inscription et une
 * source de spam (n'importe qui peut déclencher des envois). Il est désactivé
 * par défaut et ne s'active que par AUTH_EMAIL_ENABLED=1. Google reste
 * conditionné à ses identifiants.
 */

/** Un provider Auth.js est un objet de config ou une fabrique ; on ne lit que son id. */
const idsOf = (list: unknown[]): string[] =>
  list.map((p) => (typeof p === "function" ? (p as () => { id: string })() : (p as { id: string })).id);

test("I9 — sans AUTH_EMAIL_ENABLED, aucun provider e-mail", async () => {
  const { authProviders } = await import("../lib/auth-providers");
  assert.deepEqual(idsOf(authProviders({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" })), ["google"]);
  assert.deepEqual(idsOf(authProviders({})), []);
});

test("I9 — AUTH_EMAIL_ENABLED=1 ET un transport configuré activent le lien magique", async () => {
  const { authProviders, emailLoginConfigured } = await import("../lib/auth-providers");
  const ids = idsOf(authProviders({ AUTH_EMAIL_ENABLED: "1", RESEND_API_KEY: "re_x", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }));
  assert.deepEqual(ids.sort(), ["email", "google"]);
  // Activé sans transport → pas de bouton mort ni de lien dans les logs.
  assert.deepEqual(idsOf(authProviders({ AUTH_EMAIL_ENABLED: "1" })), []);
  assert.equal(emailLoginConfigured({ AUTH_EMAIL_ENABLED: "1", AUTH_EMAIL_ENDPOINT: "https://mail.example/send" }), true);
  // Transport sans activation explicite → non plus.
  assert.equal(emailLoginConfigured({ RESEND_API_KEY: "re_x" }), false);
});
