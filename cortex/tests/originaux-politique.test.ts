/**
 * OÙ VIVENT LES ORIGINAUX D'UN COMPTE (décision de Ben, 17/11/2026) : un compte gratuit ne
 * stocke rien dans le cloud ; ses fichiers restent sur son ordinateur et Cortex n'en garde que
 * l'index. Le cloud est réservé aux comptes Premium : le propriétaire, un compte qui a payé dans
 * les 365 derniers jours (paiement net positif, PR #88), un abonnement en règle.
 *
 * Seam : originalsPolicy(userId). Postgres réel (PGlite), facturation active, aucun réseau.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.BILLING_ENABLED = "1";
process.env.CORTEX_OWNER_EMAIL = "ben@example.com";
delete process.env.CORTEX_OWNER_USER_ID;
delete process.env.FREE_ORIGINALS_CLOUD;

const ENV_KEYS = ["DB_DRIVER", "DATABASE_URL", "BILLING_ENABLED", "CORTEX_OWNER_EMAIL", "FREE_ORIGINALS_CLOUD"];
const DAY_MS = 86400_000;
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 19).replace("T", " ");

let policy: typeof import("../lib/originals/policy");
let revenue: typeof import("../lib/billing/revenue");

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { authRun } = await import("../db/auth-store");
  await authRun(`INSERT INTO users (id, email, name) VALUES (?,?,?)`, "usr_ben", "ben@example.com", "Ben");
  policy = await import("../lib/originals/policy");
  revenue = await import("../lib/billing/revenue");
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ENV_KEYS) delete process.env[k];
});

const pay = (user: string, id: string, paidAt: string, amountCents = 900) =>
  revenue.recordPayment({ sourceId: `cs_${id}`, kind: "pack", paymentIntent: `pi_${id}`, userId: user, currency: "eur", amountCents, feeCents: 40, paidAt });

test("compte qui n'a jamais payé : ses originaux restent sur son ordinateur", async () => {
  const p = await policy.originalsPolicy("usr_free");
  assert.equal(p.home, "local");
  assert.equal(p.reason, "free");
  assert.equal(p.cloudUntil, null);
});

test("propriétaire : cloud, sans échéance", async () => {
  const p = await policy.originalsPolicy("usr_ben");
  assert.deepEqual([p.home, p.reason, p.cloudUntil], ["cloud", "owner", null]);
});

test("pack payé il y a 10 jours : cloud jusqu'à 365 jours après le paiement", async () => {
  const paidAt = "2026-11-07 09:30:00";
  await pay("usr_pack", "pack1", paidAt);
  const p = await policy.originalsPolicy("usr_pack", "2026-11-17 12:00:00");
  assert.deepEqual([p.home, p.reason], ["cloud", "paid"]);
  assert.equal(p.cloudUntil, "2027-11-07 09:30:00", "échéance = paiement + 365 jours");
});

test("paiement payé dans une devise sans taux (CHF) : il compte quand même comme payé", async () => {
  await revenue.recordPayment({ sourceId: "cs_chf", kind: "pack", paymentIntent: "pi_chf", userId: "usr_chf", currency: "chf", amountCents: 900, feeCents: 40, paidAt: at(3) });
  assert.equal((await policy.originalsPolicy("usr_chf")).home, "cloud");
});

test("pack entièrement remboursé : plus rien de payé, retour au gratuit", async () => {
  await pay("usr_refund", "refund1", at(5));
  await revenue.recordRefund("pi_refund1", 900);
  const p = await policy.originalsPolicy("usr_refund");
  assert.deepEqual([p.home, p.reason], ["local", "free"]);
});

test("dernier paiement il y a plus d'un an : gratuit, avec la date de fin du Premium pour la rétention", async () => {
  await pay("usr_old", "old1", at(400));
  const p = await policy.originalsPolicy("usr_old");
  assert.equal(p.home, "local");
  assert.equal(p.reason, "free");
  assert.ok(p.cloudUntil && p.cloudUntil < at(0), `fin de Premium passée attendue, reçu ${p.cloudUntil}`);
});

test("abonnement en règle sans paiement encore enregistré : cloud jusqu'à la fin de la période payée", async () => {
  const credits = await import("../lib/billing/credits");
  const end = at(-20);
  await credits.grantSubscriptionMonth({ userId: "usr_sub", customerId: "cus_sub", subscriptionId: "sub_1", plan: "pro_monthly", periodStart: at(10), periodEnd: end });
  const p = await policy.originalsPolicy("usr_sub");
  assert.deepEqual([p.home, p.reason, p.cloudUntil], ["cloud", "subscription", end]);
});

test("facturation coupée (dev, instance perso) ou kill-switch : tout le monde garde ses originaux comme avant", async () => {
  process.env.BILLING_ENABLED = "";
  try {
    assert.deepEqual([(await policy.originalsPolicy("usr_free")).home, (await policy.originalsPolicy("usr_free")).reason], ["cloud", "rule_off"]);
  } finally {
    process.env.BILLING_ENABLED = "1";
  }
  process.env.FREE_ORIGINALS_CLOUD = "1";
  try {
    assert.equal((await policy.originalsPolicy("usr_free")).home, "cloud");
  } finally {
    delete process.env.FREE_ORIGINALS_CLOUD;
  }
});
