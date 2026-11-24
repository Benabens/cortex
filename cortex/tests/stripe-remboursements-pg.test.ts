// Mécanique écrite avec le Pro à 20 crédits/mois (défaut avant le 25/11/2026, 30 depuis) : figé ici.
process.env.SUBSCRIPTION_MONTHLY_CREDITS = "20";
/**
 * REMBOURSEMENTS D'ABONNEMENT EN VRAI POSTGRES : remboursements et litige du
 * même paiement livrés EN MÊME TEMPS (Stripe rejoue, plusieurs instances) sur
 * des connexions réellement parallèles. Le cumul de la facture (`reversed_centi`)
 * est lu et écrit sous `pg_advisory_xact_lock` : rien n'est repris deux fois.
 * PGlite (une seule connexion) ne le voit pas. Événements FICTIFS, aucun appel Stripe.
 *
 * Base réelle requise : CORTEX_TEST_PG_URL (nom contenant « test »), sinon sauté ;
 * base DÉDIÉE créée puis supprimée.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const BASE_URL = process.env.CORTEX_TEST_PG_URL ?? "";
const baseDb = (() => { try { return new URL(BASE_URL).pathname.replace(/^\//, ""); } catch { return ""; } })();
const ENABLED = !!BASE_URL && /test/i.test(baseDb);
const skip = ENABLED ? false : "CORTEX_TEST_PG_URL absente (ou base sans « test » dans son nom)";
const DB = `cortextest_rembours_${process.pid}`;
const DB_URL = (() => { try { const u = new URL(BASE_URL); u.pathname = `/${DB}`; return u.toString(); } catch { return ""; } })();
const DATA_DIR = ENABLED ? fs.mkdtempSync(path.join(os.tmpdir(), "cortex-remb-pg-")) : "";
const ENV: Record<string, string> = {
  CORTEX_DATA_DIR: DATA_DIR, DB_DRIVER: "postgres", DATABASE_URL: DB_URL, PG_AUTH_POOL_MAX: "8", PG_POOL_MAX: "8",
  BILLING_ENABLED: "1", SIGNUP_FREE_CREDITS: "0", AI_BUDGET_MARGIN: "unlimited", DAILY_GEN_QUOTA: "unlimited",
  RATE_LIMIT_PER_USER_MIN: "unlimited", MAX_ACTIVE_JOBS: "unlimited",
};
if (ENABLED) Object.assign(process.env, ENV);

async function admin<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const postgres = (await import("postgres")).default;
  const sql = postgres(BASE_URL, { max: 1, onnotice: () => {} });
  try { return await fn(sql); } finally { await sql.end(); }
}

before(async () => {
  if (!ENABLED) return;
  delete process.env.CORTEX_USER;
  await admin((sql) => sql.unsafe(`CREATE DATABASE "${DB}"`));
});

after(async () => {
  if (!ENABLED) return;
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  await admin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`));
  for (const k of Object.keys(ENV)) delete process.env[k];
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const fixture = (name: string): Obj =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/stripe-remboursements/${name}.json`, import.meta.url), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (id: string, type: string, object: unknown): any => ({ id, type, object: "event", livemode: false, created: Math.floor(Date.now() / 1000), data: { object } });
const noStripe = { sessionByPaymentIntent: async () => null, invoiceByPaymentIntent: async () => null };

const paid = (user: string, month: string, startDays: number, endDays: number) => {
  const inv = fixture("invoice-pro-monthly");
  const day = (d: number) => Math.floor((Date.now() + d * 86400_000) / 1000);
  const meta = { app: "cortex", cortexUserId: user, plan: "pro_monthly" };
  inv.id = `in_${user}_${month}`;
  inv.customer = `cus_${user}`;
  inv.parent.subscription_details = { subscription: `sub_${user}`, metadata: meta };
  inv.lines.data[0].metadata = meta;
  inv.lines.data[0].parent.subscription_item_details.subscription = `sub_${user}`;
  inv.lines.data[0].period = { start: day(startDays), end: day(endDays) };
  inv.payments.data[0].payment.payment_intent = `pi_${user}_${month}`;
  return ev(`evt_${user}_${month}`, "invoice.paid", inv);
};
const refund = (evt: string, pi: string, refunded: number) =>
  ev(evt, "charge.refunded", { ...fixture("charge-invoice-refunded"), id: `ch_${pi}`, payment_intent: pi, customer: null, amount: 1490, amount_refunded: refunded });

test("vrai Postgres : 4 remboursements au même cumul + litige, en parallèle, sur la facture en cours → repris une seule fois", { skip }, async () => {
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  const credits = await import("../lib/billing/credits");
  await handleStripeEvent(paid("para", "m1", -1, 29), { lookup: noStripe });
  assert.equal(await credits.getBalance("para"), 20);

  const half = await Promise.all([1, 2, 3, 4].map((i) => handleStripeEvent(refund(`evt_para_half_${i}`, "pi_para_m1", 745), { lookup: noStripe })));
  assert.equal(half.filter((r) => r.reversed).length, 1, JSON.stringify(half));
  assert.equal(await credits.getBalance("para"), 10, "moitié remboursée : 10 repris, une fois");
  assert.equal(Number((await credits.getSubscription("para"))?.suspended), 0, "partiel : pas de suspension");

  const rest = await Promise.all([
    ...[1, 2, 3].map((i) => handleStripeEvent(refund(`evt_para_full_${i}`, "pi_para_m1", 1490), { lookup: noStripe })),
    handleStripeEvent(ev("evt_para_dispute", "charge.dispute.created", { id: "dp_para", object: "dispute", payment_intent: "pi_para_m1", amount: 1490 }), { lookup: noStripe }),
  ]);
  assert.equal(rest.filter((r) => r.reversed).length, 1, JSON.stringify(rest));
  assert.equal(await credits.getBalance("para"), 0);
  assert.equal(Number((await credits.getSubscription("para"))?.suspended), 1, "total : suspendu");
});

test("vrai Postgres : facture ANCIENNE remboursée → reliquat expiré absorbé, mois en cours intact", { skip }, async () => {
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  const credits = await import("../lib/billing/credits");
  await handleStripeEvent(paid("vieux", "m1", -1, 29), { lookup: noStripe });
  await handleStripeEvent(paid("vieux", "m2", 0, 30), { lookup: noStripe });
  const r = await Promise.all([1, 2].map((i) => handleStripeEvent(refund(`evt_vieux_${i}`, "pi_vieux_m1", 1490), { lookup: noStripe })));
  assert.equal(r.filter((x) => x.reversed).length, 1, JSON.stringify(r));
  assert.equal(await credits.subscriptionCredits("vieux"), 20);
  assert.equal(await credits.getBalance("vieux"), 20, "les 20 du mois 1 avaient expiré inutilisés : aucune dette");
  assert.equal(Number((await credits.getSubscription("vieux"))?.suspended), 0);
});

test("vrai Postgres : cumuls DIFFÉRENTS livrés ensemble (moitié puis total) → jamais plus que la facture", { skip }, async () => {
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  const credits = await import("../lib/billing/credits");
  for (let round = 0; round < 5; round++) {
    const user = `mix${round}`;
    await handleStripeEvent(paid(user, "m1", -1, 29), { lookup: noStripe });
    const rs = await Promise.all([
      handleStripeEvent(refund(`evt_${user}_half`, `pi_${user}_m1`, 745), { lookup: noStripe }),
      handleStripeEvent(refund(`evt_${user}_full`, `pi_${user}_m1`, 1490), { lookup: noStripe }),
      handleStripeEvent(refund(`evt_${user}_quarter`, `pi_${user}_m1`, 373), { lookup: noStripe }),
    ]);
    // Le solde est borné à 0 (abonnement suspendu) : une double reprise s'y cacherait. On compte ce qui a été retiré.
    const retired = rs.reduce((sum, r) => sum + (r.retiredCenti ?? 0), 0);
    assert.equal(retired, 2000, `${user} : 20 crédits retirés au total, pas davantage (${JSON.stringify(rs)})`);
    assert.equal(await credits.getBalance(user), 0);
  }
});

test("vrai Postgres : génération débitée PENDANT le remboursement total de la facture en cours → le consommé passe en dette, jamais perdu", { skip }, async () => {
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  const credits = await import("../lib/billing/credits");
  const reserve = await import("../lib/billing/reserve");
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  for (let round = 0; round < 5; round++) {
    const user = `course${round}`;
    await handleStripeEvent(paid(user, "m1", -1, 29), { lookup: noStripe });
    const [spent] = await Promise.all([
      runWithUser(user, () => runWithCourse("ml", () => reserve.reserveGeneration({ bucket: "gen", kind: "exam", costCenti: 500, ref: `job:${user}:1` }))),
      handleStripeEvent(refund(`evt_${user}_full`, `pi_${user}_m1`, 1490), { lookup: noStripe }),
    ]);
    // Débit avant la reprise : 5 consommés → dette de 5. Débit après : refusé (abonnement suspendu, solde 0).
    assert.equal(await credits.getBalance(user), spent.ok ? -5 : 0, `${user} : ${JSON.stringify(spent)}`);
  }
});
