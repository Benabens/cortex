/**
 * CONNEXION RELECTEUR (lib/review-login) — e-mail + mot de passe du compte démo
 * des annuaires de connecteurs. Fermée sans ses deux variables ; liée à une
 * seule adresse ; jamais propriétaire ; limitée en débit ; coupée avec ses
 * sessions. Les crédits `review_grant` ne sont pas un revenu, mais sont servis.
 * Base : Postgres réel (PGlite), comme les tests OAuth.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";

const EMAIL = "relecteur@review.cortex.test";
// Mot de passe de test, inventé pour ce fichier (aucune valeur réelle).
const PASSWORD = "mot-de-passe-de-test-relecteur";
let HASH = "";
const req = (ip: string) => ({ headers: new Headers({ "x-forwarded-for": ip }) });
const envWith = (extra: Record<string, string> = {}) => ({
  REVIEW_LOGIN_EMAIL: EMAIL, REVIEW_LOGIN_PASSWORD_HASH: HASH, TRUST_PROXY: "1", ...extra,
});

/** Un provider Auth.js est un objet de config ou une fabrique ; on ne lit que son id (Credentials le porte dans options). */
type P = { id: string; options?: { id?: string } };
const idsOf = (list: unknown[]): string[] =>
  list.map((p) => (typeof p === "function" ? (p as () => P)() : (p as P))).map((p) => p.options?.id ?? p.id);

before(async () => {
  const { hashReviewPassword } = await import("../lib/review-login");
  HASH = await hashReviewPassword(PASSWORD, 14);
});

beforeEach(async () => {
  const { resetReviewLoginLimiter } = await import("../lib/review-login");
  resetReviewLoginLimiter();
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL"]) delete process.env[k];
});

test("désactivée sans ses deux variables : aucun fournisseur, rien à afficher", async () => {
  const { authProviders, reviewLoginConfigured } = await import("../lib/auth-providers");
  assert.deepEqual(idsOf(authProviders({})), []);
  assert.deepEqual(idsOf(authProviders({ REVIEW_LOGIN_EMAIL: EMAIL })), [], "e-mail seul");
  assert.deepEqual(idsOf(authProviders({ REVIEW_LOGIN_PASSWORD_HASH: HASH })), [], "hash seul");
  assert.deepEqual(idsOf(authProviders({ REVIEW_LOGIN_EMAIL: EMAIL, REVIEW_LOGIN_PASSWORD_HASH: "scrypt:1:1:1:x:y" })), [], "hash illisible");
  assert.equal(reviewLoginConfigured({}), false);
  assert.deepEqual(idsOf(authProviders(envWith())), ["review"]);
  assert.equal(reviewLoginConfigured(envWith()), true);
});

test("fermée pour l'adresse du propriétaire, et après REVIEW_LOGIN_UNTIL (date illisible = fermée)", async () => {
  const { reviewLoginActive } = await import("../lib/review-login");
  assert.equal(reviewLoginActive(envWith({ CORTEX_OWNER_EMAIL: "Relecteur@Review.Cortex.Test" })), false);
  const now = new Date("2026-11-20T12:00:00Z");
  assert.equal(reviewLoginActive(envWith({ REVIEW_LOGIN_UNTIL: "2026-12-01T00:00:00Z" }), now), true);
  assert.equal(reviewLoginActive(envWith({ REVIEW_LOGIN_UNTIL: "2026-11-20T11:59:59Z" }), now), false);
  assert.equal(reviewLoginActive(envWith({ REVIEW_LOGIN_UNTIL: "bientôt" }), now), false);
});

test("hash scrypt : bon mot de passe accepté, mauvais refusé, paramètres hors bornes refusés", async () => {
  const { hashReviewPassword, parseReviewHash, verifyReviewPassword } = await import("../lib/review-login");
  assert.match(HASH, /^scrypt:14:8:1:[\w-]+:[\w-]+$/);
  assert.equal(await verifyReviewPassword(PASSWORD, HASH), true);
  assert.equal(await verifyReviewPassword(`${PASSWORD} `, HASH), false);
  assert.equal(await verifyReviewPassword("", HASH), false);
  assert.notEqual(await hashReviewPassword(PASSWORD, 14), HASH, "sel aléatoire");
  const [, , r, p, salt, key] = HASH.split(":");
  assert.equal(parseReviewHash(["scrypt", 30, r, p, salt, key].join(":")), null, "N = 2^30 : refusé avant toute dérivation");
  assert.equal(await verifyReviewPassword(PASSWORD, "argon2id:whatever"), false);
});

test("mauvais e-mail refusé, même avec le bon mot de passe ; aucun compte créé", async () => {
  const { authorizeReview } = await import("../lib/review-login");
  const { authGet } = await import("../db/auth-store");
  assert.equal(await authorizeReview({ email: "autre@review.cortex.test", password: PASSWORD }, req("203.0.113.1"), envWith()), null);
  assert.equal(await authorizeReview({ email: "", password: PASSWORD }, req("203.0.113.1"), envWith()), null);
  const n = await authGet<{ n: number | string }>("SELECT count(*) n FROM users WHERE email = ?", "autre@review.cortex.test");
  assert.equal(Number(n?.n ?? 0), 0);
});

test("mauvais mot de passe refusé ; le bon ouvre toujours le même compte, adresse sans casse", async () => {
  const { authorizeReview } = await import("../lib/review-login");
  assert.equal(await authorizeReview({ email: EMAIL, password: "pas-le-bon-mot-de-passe" }, req("203.0.113.2"), envWith()), null);
  assert.equal(await authorizeReview({ email: EMAIL, password: "" }, req("203.0.113.2"), envWith()), null);
  const first = await authorizeReview({ email: EMAIL, password: PASSWORD }, req("203.0.113.2"), envWith());
  assert.ok(first, "connexion attendue");
  assert.equal(first.email, EMAIL);
  const again = await authorizeReview({ email: " RELECTEUR@review.cortex.test ", password: PASSWORD }, req("203.0.113.3"), envWith());
  assert.equal(again?.id, first.id);
});

test("fermée (variables retirées ou date passée) : refus même avec les bons identifiants", async () => {
  const { authorizeReview } = await import("../lib/review-login");
  assert.equal(await authorizeReview({ email: EMAIL, password: PASSWORD }, req("203.0.113.4"), {}), null);
  assert.equal(await authorizeReview({ email: EMAIL, password: PASSWORD }, req("203.0.113.4"), envWith({ REVIEW_LOGIN_UNTIL: "2020-01-01" })), null);
});

test("jamais propriétaire : compte désigné par CORTEX_OWNER_USER_ID refusé", async () => {
  const { authorizeReview } = await import("../lib/review-login");
  const user = await authorizeReview({ email: EMAIL, password: PASSWORD }, req("203.0.113.5"), envWith());
  assert.ok(user);
  assert.equal(await authorizeReview({ email: EMAIL, password: PASSWORD }, req("203.0.113.6"), envWith({ CORTEX_OWNER_USER_ID: user.id })), null);
});

test("limite de débit : 5 essais par IP sur 15 min, puis refus même avec le bon mot de passe", async () => {
  const { authorizeReview, ReviewRateLimited, REVIEW_MAX_PER_IP } = await import("../lib/review-login");
  for (let i = 0; i < REVIEW_MAX_PER_IP; i++) {
    assert.equal(await authorizeReview({ email: EMAIL, password: `faux-${i}` }, req("198.51.100.7"), envWith()), null);
  }
  await assert.rejects(authorizeReview({ email: EMAIL, password: PASSWORD }, req("198.51.100.7"), envWith()), ReviewRateLimited);
  // Une autre IP n'est pas pénalisée.
  assert.ok(await authorizeReview({ email: EMAIL, password: PASSWORD }, req("198.51.100.8"), envWith()));
});

test("limite globale et fenêtre glissante de 15 min", async () => {
  const { REVIEW_MAX_GLOBAL, REVIEW_MAX_PER_IP, REVIEW_WINDOW_MS, takeReviewAttempt } = await import("../lib/review-login");
  const t0 = Date.parse("2026-11-20T12:00:00Z");
  for (let i = 0; i < REVIEW_MAX_GLOBAL; i++) assert.equal(takeReviewAttempt(`192.0.2.${i}`, t0), true);
  assert.equal(takeReviewAttempt("192.0.2.250", t0 + 1000), false, "plafond global atteint, IP neuve comprise");
  assert.equal(takeReviewAttempt("192.0.2.250", t0 + REVIEW_WINDOW_MS + 1), true, "fenêtre écoulée");
  for (let i = 1; i < REVIEW_MAX_PER_IP; i++) takeReviewAttempt("192.0.2.251", t0 + REVIEW_WINDOW_MS + 1 + i);
  assert.equal(takeReviewAttempt("192.0.2.251", t0 + REVIEW_WINDOW_MS + 100), true);
  assert.equal(takeReviewAttempt("192.0.2.251", t0 + REVIEW_WINDOW_MS + 101), false);
});

test("sans TRUST_PROXY, l'en-tête X-Forwarded-For est ignoré (tous les essais partagent une clé)", async () => {
  const { authorizeReview, REVIEW_MAX_PER_IP } = await import("../lib/review-login");
  const env = { REVIEW_LOGIN_EMAIL: EMAIL, REVIEW_LOGIN_PASSWORD_HASH: HASH };
  for (let i = 0; i < REVIEW_MAX_PER_IP; i++) await authorizeReview({ email: EMAIL, password: "faux" }, req(`10.0.0.${i}`), env);
  await assert.rejects(authorizeReview({ email: EMAIL, password: PASSWORD }, req("10.0.0.99"), env));
});

test("session : la connexion relecteur coupée invalide les sessions ouvertes par elle, pas les autres", async () => {
  const saved = { e: process.env.REVIEW_LOGIN_EMAIL, h: process.env.REVIEW_LOGIN_PASSWORD_HASH };
  try {
    process.env.REVIEW_LOGIN_EMAIL = EMAIL;
    process.env.REVIEW_LOGIN_PASSWORD_HASH = HASH;
    const { authCallbacks } = await import("../lib/auth");
    const jwt = authCallbacks.jwt as unknown as (p: Record<string, unknown>) => Record<string, unknown> | null;
    const signIn = authCallbacks.signIn as unknown as (p: Record<string, unknown>) => boolean;
    const opened = jwt({ token: {}, user: { id: "u1" }, account: { provider: "review" } });
    assert.equal(opened?.review, true);
    assert.ok(jwt({ token: { ...opened } }), "ouverte : la session reste");
    // Lancement fermé : le compte démo passe quand même (ses variables valent invitation).
    process.env.INVITE_ONLY = "1";
    assert.equal(signIn({ user: { email: EMAIL }, account: { provider: "review" } }), true);
    assert.equal(signIn({ user: { email: EMAIL }, account: { provider: "google" } }), false);
    delete process.env.INVITE_ONLY;
    delete process.env.REVIEW_LOGIN_PASSWORD_HASH;
    assert.equal(jwt({ token: { ...opened } }), null, "coupée : la session tombe");
    assert.ok(jwt({ token: { uid: "u2" } }), "une session Google n'est pas touchée");
  } finally {
    delete process.env.INVITE_ONLY;
    if (saved.e === undefined) delete process.env.REVIEW_LOGIN_EMAIL; else process.env.REVIEW_LOGIN_EMAIL = saved.e;
    if (saved.h === undefined) delete process.env.REVIEW_LOGIN_PASSWORD_HASH; else process.env.REVIEW_LOGIN_PASSWORD_HASH = saved.h;
  }
});

test("crédits review_grant : aucun revenu pour le budget, mais servis comme des crédits achetés", async () => {
  const { ensureReviewUser } = await import("../lib/review-login");
  const { addTransaction } = await import("../lib/billing/credits");
  const { accountRevenue } = await import("../lib/billing/revenue");
  const { accountBudget, purchasedLedgerCenti } = await import("../lib/billing/budget");
  const { authGet } = await import("../db/auth-store");
  const user = await ensureReviewUser(EMAIL);
  const ref = `review_grant:${user.id}:test`;
  assert.equal(await addTransaction(user.id, 2000, "review_grant", ref), true);
  assert.equal(await addTransaction(user.id, 2000, "review_grant", ref), false, "idempotent par référence");
  assert.equal((await accountRevenue(user.id)).netUsd, 0);
  // Le budget n'existe qu'en déploiement gardé (facturation active).
  process.env.BILLING_ENABLED = "1";
  try {
    const budget = await accountBudget(user.id);
    assert.equal(budget?.revenueUsd, 0);
    assert.equal(budget?.budgetUsd, 0, "aucun budget « offert » tiré de ces crédits");
  } finally {
    delete process.env.BILLING_ENABLED;
  }
  assert.equal(await purchasedLedgerCenti({ get: authGet } as never, user.id, 2000), 2000);
});
