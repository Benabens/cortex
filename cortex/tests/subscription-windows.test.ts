/**
 * BUG ARGENT (prod) — la recharge paresseuse au changement de MOIS CALENDAIRE
 * cumulait avec invoice.paid : un mensuel pris le 28/09 recevait 20 le 28/09,
 * 20 le 01/10 et 20 le 28/10 (≈ 40 crédits par mois payé), et un mois remboursé
 * se rechargeait au 1er suivant. Règles :
 *  - MENSUEL : les crédits ne viennent QUE d'une facture payée ; fenêtre = période de facturation ;
 *  - ANNUEL : 12 fenêtres mensuelles ancrées sur le début de période (même jour du
 *    mois, fin de mois gérée), une recharge par fenêtre, jamais au-delà de period_end ;
 *  - après reprise (remboursement / litige) d'une facture : SUSPENDU, plus rien
 *    jusqu'à une nouvelle facture payée ;
 *  - la ligne existante migre sans perte.
 * Horloge simulée (mock.timers sur Date).
 */
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "0";
process.env.DAILY_GEN_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.MAX_ACTIVE_JOBS = "unlimited";

const at = (iso: string) => mock.timers.setTime(new Date(iso).getTime());
const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (id: string, type: string, object: unknown): any => ({ id, type, data: { object } });
const invoice = (id: string, user: string, customer: string, sub: string, plan: "cortex_pro_monthly" | "cortex_pro_yearly", start: string, end: string, pi = `pi_${id}`) =>
  ev(id, "invoice.paid", { id: `in_${id}`, customer, subscription: sub, payment_intent: pi, subscription_details: { metadata: { app: "cortex", cortexUserId: user } },
    lines: { data: [{ period: { start: unix(start), end: unix(end) }, price: { lookup_key: plan } }] } });

before(async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-28T10:00:00Z").getTime() });
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(async () => {
  mock.timers.reset();
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_GEN_QUOTA", "RATE_LIMIT_PER_USER_MIN", "MAX_ACTIVE_JOBS"]) delete process.env[k];
});

const spend = async (user: string, ref: string) => {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  return runWithUser(user, () => runWithCourse("ml", () => reserveGeneration({ bucket: "gen", kind: "exam", ref })));
};

test("fenêtres : même jour du mois, fin de mois gérée, jamais au-delà de la période", async () => {
  const w = await import("../lib/billing/subscription-windows");
  assert.equal(w.addMonthsClamped("2026-01-31 10:00:00", 1), "2026-02-28 10:00:00");
  assert.equal(w.addMonthsClamped("2026-01-31 10:00:00", 2), "2026-03-31 10:00:00");
  assert.equal(w.addMonthsClamped("2028-01-31 10:00:00", 1), "2028-02-29 10:00:00");
  assert.equal(w.currentWindowStart("2026-01-31 10:00:00", "2026-03-15 00:00:00"), "2026-02-28 10:00:00");
  assert.equal(w.currentWindowStart("2026-01-31 10:00:00", "2026-03-31 10:00:00"), "2026-03-31 10:00:00");
  assert.equal(w.nextWindowStart("2026-01-31 10:00:00", "2026-03-15 00:00:00", "2027-01-31 10:00:00"), "2026-03-31 10:00:00");
  assert.equal(w.nextWindowStart("2026-01-31 10:00:00", "2027-01-20 00:00:00", "2027-01-31 10:00:00"), null, "la 13e fenêtre serait la fin de période");
});

test("MENSUEL pris le 28/09 : 20 jusqu'à la facture suivante, aucune recharge le 1er, puis 20 avec la facture du 28/10", async () => {
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  const credits = await import("../lib/billing/credits");
  at("2026-09-28T10:00:00Z");
  await handleStripeEvent(invoice("m1", "moe", "cus_moe", "sub_moe", "cortex_pro_monthly", "2026-09-28T10:00:00Z", "2026-10-28T10:00:00Z"));
  assert.equal(await credits.subscriptionCredits("moe"), 20);
  assert.equal((await spend("moe", "job:moe:ml:1")).ok, true);
  assert.equal(await credits.subscriptionCredits("moe"), 18);
  at("2026-10-01T09:00:00Z");
  assert.equal(await credits.subscriptionCredits("moe"), 18, "pas de recharge au changement de mois calendaire");
  assert.equal((await spend("moe", "job:moe:ml:2")).ok, true);
  assert.equal(await credits.subscriptionCredits("moe"), 16, "la réservation ne recharge pas non plus");
  at("2026-10-27T09:00:00Z");
  assert.equal(await credits.subscriptionCredits("moe"), 16);
  at("2026-10-28T12:00:00Z");
  assert.equal(await credits.subscriptionCredits("moe"), 0, "période échue sans facture → rien");
  await handleStripeEvent(invoice("m2", "moe", "cus_moe", "sub_moe", "cortex_pro_monthly", "2026-10-28T10:00:00Z", "2026-11-28T10:00:00Z"));
  assert.equal(await credits.subscriptionCredits("moe"), 20, "la facture du 28/10 rouvre 20 (reliquat perdu)");
  const { GET } = await import("../app/api/billing/route");
  const { NextRequest } = await import("next/server");
  const body = await (await GET(new NextRequest("http://cortex.test/api/billing", { headers: { "x-cortex-user": "moe" } }))).json();
  assert.equal(body.subscription.nextRechargeAt, "2026-11-28", "prochaine recharge = prochaine facture");
});

test("ANNUEL pris le 31/01 : recharges le 28/02 et le 31/03, une seule par fenêtre, rien après la fin de période", async () => {
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  const credits = await import("../lib/billing/credits");
  at("2026-01-31T10:00:00Z");
  await handleStripeEvent(invoice("y1", "yan", "cus_yan", "sub_yan", "cortex_pro_yearly", "2026-01-31T10:00:00Z", "2027-01-31T10:00:00Z"));
  assert.equal(await credits.subscriptionCredits("yan"), 20);
  assert.equal((await spend("yan", "job:yan:ml:1")).ok, true);
  at("2026-02-01T00:00:00Z");
  assert.equal(await credits.subscriptionCredits("yan"), 18, "le 1er février n'est pas une fenêtre");
  at("2026-02-28T09:59:00Z");
  assert.equal(await credits.subscriptionCredits("yan"), 18, "une minute avant la fenêtre");
  at("2026-02-28T10:00:00Z");
  assert.equal(await credits.subscriptionCredits("yan"), 20, "fenêtre du 28/02 (février n'a pas de 31)");
  assert.equal((await spend("yan", "job:yan:ml:2")).ok, true);
  at("2026-03-15T00:00:00Z");
  assert.equal(await credits.subscriptionCredits("yan"), 18, "pas de seconde recharge dans la même fenêtre");
  at("2026-03-31T10:00:00Z");
  assert.equal((await spend("yan", "job:yan:ml:3")).ok, true, "la réservation recharge dans sa transaction");
  assert.equal(await credits.subscriptionCredits("yan"), 18, "20 rechargés le 31/03 puis 2 consommés");
  at("2027-01-30T00:00:00Z");
  assert.equal(await credits.subscriptionCredits("yan"), 20, "12e fenêtre (31/12) rechargée");
  at("2027-01-31T10:00:00Z");
  assert.equal(await credits.subscriptionCredits("yan"), 0, "fin de période : plus rien sans nouvelle facture");
});

test("REPRISE d'une facture (remboursement) → suspendu : 0 immédiatement, 0 à la fenêtre suivante, 20 à la prochaine facture payée", async () => {
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  const credits = await import("../lib/billing/credits");
  at("2026-04-10T10:00:00Z");
  await handleStripeEvent(invoice("r1", "rae", "cus_rae", "sub_rae", "cortex_pro_yearly", "2026-04-10T10:00:00Z", "2027-04-10T10:00:00Z", "pi_rae_1"));
  assert.equal(await credits.subscriptionCredits("rae"), 20);
  await handleStripeEvent(ev("evt_rae_refund", "charge.refunded", { payment_intent: "pi_rae_1", amount: 11900, amount_refunded: 11900, customer: "cus_rae" }));
  assert.equal(await credits.subscriptionCredits("rae"), 0);
  at("2026-05-10T10:00:00Z");
  assert.equal(await credits.subscriptionCredits("rae"), 0, "suspendu : la fenêtre suivante ne recharge pas");
  assert.equal((await spend("rae", "job:rae:ml:1")).ok, false, "et la réservation non plus");
  at("2026-06-01T00:00:00Z");
  assert.equal(await credits.subscriptionCredits("rae"), 0);
  await handleStripeEvent(invoice("r2", "rae", "cus_rae", "sub_rae", "cortex_pro_yearly", "2026-06-01T00:00:00Z", "2027-06-01T00:00:00Z", "pi_rae_2"));
  assert.equal(await credits.subscriptionCredits("rae"), 20, "nouvelle facture payée → reprise du service");
});

test("migration : une ligne existante (month_anchor seul) garde ses crédits et ne recharge plus au 1er si mensuelle", async () => {
  const { authRun, authGet } = await import("../db/auth-store");
  const credits = await import("../lib/billing/credits");
  at("2026-09-28T12:00:00Z");
  // Ligne telle que l'ancien code l'a laissée en production : mensuel, 20 accordés le 28/09, month_anchor calendaire.
  await authRun(`INSERT INTO subscriptions (user_id, customer_id, subscription_id, status, plan, monthly_credits, remaining, period_end, month_anchor, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`, "legacy", "cus_legacy", "sub_legacy", "active", "cortex_pro_monthly", 2000, 1500, "2026-10-28 10:00:00", "2026-09", "2026-09-28 10:00:00");
  assert.equal(await credits.subscriptionCredits("legacy"), 15, "rien de perdu");
  at("2026-10-02T12:00:00Z");
  assert.equal(await credits.subscriptionCredits("legacy"), 15, "plus de recharge calendaire");
  const row = await authGet<{ suspended: number; period_start: string | null }>(`SELECT suspended, period_start FROM subscriptions WHERE user_id = ?`, "legacy");
  assert.equal(Number(row?.suspended ?? 0), 0);
});
