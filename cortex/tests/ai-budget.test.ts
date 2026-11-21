/**
 * BUDGET IA LIÉ AU REVENU — règle de Ben : ce que Cortex dépense en IA pour un
 * compte (jobs échoués et remboursés compris) reste inférieur à ce que ce compte
 * a payé sur Stripe, net. Budget B = AI_BUDGET_FREE_USD + marge × revenu net
 * 12 mois ; une génération est refusée (402) si la dépense 12 mois + le coût
 * attendu du job dépasse B — SAUF si elle est payée par des crédits ACHETÉS
 * (packs, abonnement en cours) : ceux-là restent toujours utilisables.
 *
 * Plafond du jour par compte : min(SPEND_CAP_PER_USER_USD, max(plancher, ¼ B)),
 * vérifié AVANT de lancer un job (429, les crédits restent acquis). Plafond global
 * des comptes clients : SPEND_CAP_BASE_USD + marge × revenu du mois (ou moyenne
 * mensuelle de l'année si plus haute) ; SPEND_CAP_USD reste le fusible total.
 * Le propriétaire est exempt du budget et du plafond lié au revenu.
 *
 * Seams : reserve.reserveGeneration, usage.assertSpendCap, budget.accountBudget.
 * Store Postgres/PGlite en mémoire, aucun appel au modèle.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

const ENV: Record<string, string> = {
  DB_DRIVER: "postgres",
  DATABASE_URL: "pglite://memory",
  BILLING_ENABLED: "1",
  SIGNUP_FREE_CREDITS: "0",
  DAILY_GEN_QUOTA: "unlimited",
  DAILY_ASSIST_QUOTA: "unlimited",
  RATE_LIMIT_PER_USER_MIN: "unlimited",
  MAX_ACTIVE_JOBS: "unlimited",
  FX_USD_JSON: JSON.stringify({ eur: 1 }),
  CREDITS_COST_JSON: JSON.stringify({ qcm: 2 }),   // prix de prod : un QCM standard = 2 crédits
  AI_BUDGET_MARGIN: "0.6",
  AI_JOB_COST_USD_JSON: JSON.stringify({ qcm: 4, exam: 2, assist: 0.1 }),
  SPEND_CAP_PER_USER_USD: "50",
  SPEND_CAP_PER_USER_FLOOR_USD: "8",
  SPEND_CAP_USD: "200",
  SPEND_CAP_BASE_USD: "20",
  CORTEX_OWNER_USER_ID: "boss",
};
Object.assign(process.env, ENV);

import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";

let reserve: typeof import("../lib/billing/reserve");
let credits: typeof import("../lib/billing/credits");
let revenue: typeof import("../lib/billing/revenue");
let budget: typeof import("../lib/billing/budget");
let usage: typeof import("../lib/billing/usage");
let authRun: typeof import("../db/auth-store").authRun;
let nowStr: typeof import("../db/q").nowStr;
let handleStripeEvent: typeof import("../lib/billing/stripe-events").handleStripeEvent;

before(async () => {
  delete process.env.AI_BUDGET_FREE_USD;
  reserve = await import("../lib/billing/reserve");
  credits = await import("../lib/billing/credits");
  revenue = await import("../lib/billing/revenue");
  budget = await import("../lib/billing/budget");
  usage = await import("../lib/billing/usage");
  ({ authRun } = await import("../db/auth-store"));
  ({ nowStr } = await import("../db/q"));
  ({ handleStripeEvent } = await import("../lib/billing/stripe-events"));
});
beforeEach(() => usage.resetSpendCache());
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres?.();
  for (const k of [...Object.keys(ENV), "AI_BUDGET_FREE_USD"]) delete process.env[k];
});

const inMl = <T,>(user: string, fn: () => Promise<T>) => runWithUser(user, () => runWithCourse("ml", fn));
let n = 0;
const reserveQcm = (user: string) => inMl(user, () => reserve.reserveGeneration({ bucket: "gen", kind: "qcm", costCenti: 200, ref: `job:${user}:ml:${++n}`, jobSlot: true }));
const reserveAssist = (user: string) => inMl(user, () => reserve.reserveGeneration({ bucket: "assist", kind: "drill", costCenti: 10, ref: `assist:${user}:${++n}` }));

/** Dépense IA réelle (llm_usage), `daysAgo` jours en arrière. */
async function spend(user: string, usd: number, daysAgo = 0) {
  await authRun(
    `INSERT INTO llm_usage (user_id, course, provider, model, tokens_in, tokens_out, cost_usd, estimated, job_id, call_site, created_at)
     VALUES (?, 'ml', 'anthropic', 'claude-sonnet-5', 1000, 500, ?, 0, '1', 'qcm:generateBatch', ?)`,
    user, usd, nowStr(-daysAgo * 86400_000),
  );
}
/** Revenu encaissé sans passer par Stripe (seam revenue) : `euros` nets de frais (frais réels 0). */
async function paid(user: string, euros: number, id = `cs_${user}_${++n}`) {
  await revenue.recordPayment({ sourceId: id, kind: "pack", paymentIntent: `pi_${id}`, userId: user, currency: "eur", amountCents: euros * 100, feeCents: 0 });
}
/** Crédits NON achetés (offerts) : ni pack Stripe ni abonnement. */
const gift = (user: string, creditsN: number) => credits.addTransaction(user, creditsN * 100, "signup", `signup:${user}`);

test("compte sans aucun paiement : crédits offerts bloqués par le budget (402, message clair), rien n'est débité", async () => {
  await gift("free1", 5);
  const r = await reserveQcm("free1");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 402);
  // Le message dit vrai : le solde (5 crédits) n'est pas nié, c'est la limite des crédits offerts qui bloque.
  assert.equal(r.code, "billing_free_budget_exceeded");
  assert.deepEqual(r.params, { balance: 5, paid: 0, cost: 2 });
  assert.match(r.error, /solde de 5 crédits/);
  assert.match(r.error, /aucun n’est acheté/);
  assert.match(r.error, /crédits offerts/);
  assert.doesNotMatch(r.error, /https?:\/\//, "pas d'URL brute : l'interface met le lien Recharger");
  assert.equal(await credits.getBalanceCenti("free1"), 500);
});

test("Mon usage : la limite des crédits offerts tient en une ligne par type avec un lien Recharger, l'explication une seule fois", async () => {
  await gift("free-usage", 5);
  const { getUsageLimits } = await import("../lib/billing/limits");
  const { UsageView } = await import("../app/compte/UsagePanel");
  const { renderIntl } = await import("./helpers/intl");
  const { createElement } = await import("react");
  const data = await inMl("free-usage", () => getUsageLimits("free-usage"));
  const blocked = Object.values(data.generations).filter((g) => g.blockedBy === "free_budget");
  assert.ok(blocked.length >= 2, `plusieurs types bloqués par la limite : ${JSON.stringify(Object.values(data.generations).map((g) => g.blockedBy))}`);
  const html = renderIntl(createElement(UsageView, { data }));
  assert.doesNotMatch(html, /Limite des crédits offerts atteinte/, "le motif long n'est pas répété ligne par ligne");
  assert.equal(html.split("la limite d’usage de ces crédits est atteinte").length - 1, 1, "l'explication tient en une note");
  const refused = Object.values(data.generations).filter((g) => !g.allowed);   // + l'examen (6 crédits), bloqué par le solde
  assert.equal(html.split(">Recharger</a>").length - 1, refused.length, "un lien Recharger par type bloqué");
  assert.match(html, /Il te faut 2 crédits achetés/);
  assert.match(html, /href="#credits"/);
  assert.doesNotMatch(html, /https?:\/\//, "aucune URL brute");
  // Sous « Préparer le cours » : le motif, puis un vrai lien Recharger.
  const { UsageLine } = await import("../components/billing/UsageIndicator");
  const line = renderIntl(createElement(UsageLine, { usage: data.generations.prepare, now: data.now }));
  assert.match(line, /Limite des crédits offerts atteinte/);
  assert.match(line, /<a href="\/compte#credits"[^>]*>Recharger<\/a>/);
  assert.doesNotMatch(line, /cortexexam\.com/, "aucune URL brute");
});

test("AI_BUDGET_FREE_USD : un essai gratuit borné ; la dépense déjà faite (échecs remboursés compris) compte", async () => {
  process.env.AI_BUDGET_FREE_USD = "1";
  try {
    await gift("free2", 5);
    assert.equal((await reserveAssist("free2")).ok, true);   // 0 + 0,10 ≤ 1
    // Un job a échoué et a été remboursé : ses crédits reviennent, sa dépense IA reste.
    await spend("free2", 0.95);
    const r = await reserveAssist("free2");                  // 0,95 + 0,10 > 1
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 402);
  } finally {
    delete process.env.AI_BUDGET_FREE_USD;
  }
});

test("revenu suffisant : budget = 0,6 × revenu net, crédits offerts utilisables tant que dépense + coût attendu ≤ budget", async () => {
  await paid("rich", 20);                    // B = 12 $
  await gift("rich", 10);
  await spend("rich", 7.5, 1);
  assert.equal((await reserveQcm("rich")).ok, true);        // 7,5 + 4 ≤ 12
  await spend("rich", 1, 1);
  const r = await reserveQcm("rich");                       // 8,5 + 4 > 12
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 402);
  const b = (await budget.accountBudget("rich"))!;
  assert.equal(b.budgetUsd, 12);
  assert.equal(b.spentUsd, 8.5);
});

test("dépense de plus de 12 mois : sortie de la fenêtre", async () => {
  await paid("old", 10);                     // B = 6 $
  await gift("old", 4);
  await spend("old", 30, 400);
  assert.equal((await budget.accountBudget("old"))!.spentUsd, 0);
  assert.equal((await reserveQcm("old")).ok, true);
});

test("GARANTIE : crédits achetés (pack Stripe) toujours utilisables, même budget dépassé", async () => {
  // Pack à 9 € (frais 38 c) → revenu net 8,62 $ → B ≈ 5,17 $. Dépense déjà 10 $.
  await handleStripeEvent({
    id: "evt_pk1", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: {
      id: "cs_pk1", mode: "payment", payment_status: "paid", payment_intent: "pi_pk1", amount_total: 900, currency: "eur",
      metadata: { cortexUserId: "buyer", plan: "credits_10", credits: "10" },
    } },
  } as never, { lookup: { async sessionByPaymentIntent() { return null; }, async paymentDetails() { return { feeCents: 38 }; } } });
  await spend("buyer", 10, 2);
  const r = await reserveQcm("buyer");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await credits.getBalanceCenti("buyer"), 800);
});

test("GARANTIE : la garantie couvre les crédits achetés, pas les offerts ajoutés par-dessus", async () => {
  await handleStripeEvent({
    id: "evt_pk2", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: {
      id: "cs_pk2", mode: "payment", payment_status: "paid", payment_intent: "pi_pk2", amount_total: 900, currency: "eur",
      metadata: { cortexUserId: "mixed", plan: "credits_10", credits: "10" },
    } },
  } as never, { lookup: { async sessionByPaymentIntent() { return null; }, async paymentDetails() { return { feeCents: 38 }; } } });
  await gift("mixed", 4);                     // 14 crédits dont 10 achetés
  await spend("mixed", 10, 2);                // budget dépassé
  for (let i = 0; i < 5; i++) assert.equal((await reserveQcm("mixed")).ok, true, `QCM ${i + 1}`); // 10 crédits achetés
  const r = await reserveQcm("mixed");        // reste 4 crédits OFFERTS, budget dépassé
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 402);
});

test("propriétaire : exempt du budget", async () => {
  await spend("boss", 30, 3);
  assert.equal((await reserveQcm("boss")).ok, true);
});

test("plafond du jour par compte : min(fusible, max(plancher, ¼ B)), vérifié avant de lancer (429, crédits acquis)", async () => {
  await paid("daily", 100);                  // B = 60 $ → ¼ B = 15 $ ; fusible 50 → plafond 15 $/jour
  await gift("daily", 20);
  assert.equal(budget.dailySpendCapUsd(60), 15);
  assert.equal(budget.dailySpendCapUsd(5), 8);   // plancher : jamais sous le coût d'un gros QCM
  assert.equal(budget.dailySpendCapUsd(1000), 50);
  await spend("daily", 12);
  const r = await reserveQcm("daily");            // 12 + 4 > 15
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 429);
  assert.match(r.error, /demain/);
  assert.equal(await credits.getBalanceCenti("daily"), 2000);
});

test("plafond global lié au revenu : vérifié au lancement, il borne ce que les paiements ne couvrent pas, jamais les crédits achetés ; SPEND_CAP_USD reste le fusible", async () => {
  // Les fusibles (par compte et par jour, total du mois) sont hors sujet ici, sauf à la fin.
  process.env.SPEND_CAP_PER_USER_USD = "unlimited";
  process.env.SPEND_CAP_USD = "100000";
  try {
    // « gifted » a payé (budget large) mais lance avec des crédits OFFERTS ; « buyer2 » avec des crédits achetés.
    await paid("gifted", 100);
    await gift("gifted", 4);
    await handleStripeEvent({
      id: "evt_pk3", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), livemode: false,
      data: { object: {
        id: "cs_pk3", mode: "payment", payment_status: "paid", payment_intent: "pi_pk3", amount_total: 900, currency: "eur",
        metadata: { cortexUserId: "buyer2", plan: "credits_10", credits: "10" },
      } },
    } as never, { lookup: { async sessionByPaymentIntent() { return null; }, async paymentDetails() { return { feeCents: 38 }; } } });
    // La dépense des clients du mois atteint le plafond lié au revenu.
    const cap = await budget.globalRevenueCapUsd();
    assert.ok(cap !== null && cap >= 20);
    await spend("whale", Math.max(0, cap! - (await budget.clientMonthSpendUsd())) + 0.01);
    const refused = await reserveQcm("gifted");
    assert.equal(refused.ok, false, "dépense non couverte par un paiement : refusée");
    assert.equal(!refused.ok && refused.status, 402);
    assert.match(!refused.ok ? refused.error : "", /achet/i, "le message dit que les crédits achetés restent utilisables");
    // Crédits achetés : servis, au lancement comme à chaque appel payant.
    assert.equal((await reserveQcm("buyer2")).ok, true);
    usage.resetSpendCache();
    await inMl("buyer2", () => usage.assertSpendCap("anthropic"));
    await inMl("boss", () => usage.assertSpendCap("anthropic"));
    // Plus de revenu → le plafond monte, la dépense offerte repasse.
    await paid("payer", 1000);
    assert.equal((await reserveQcm("gifted")).ok, true);
    // Le fusible total vaut pour tous, propriétaire compris.
    process.env.SPEND_CAP_USD = "1";
    usage.resetSpendCache();
    await assert.rejects(inMl("boss", () => usage.assertSpendCap("anthropic")), (e: Error & { code?: string }) => e.code === "SPEND_CAP");
  } finally {
    process.env.SPEND_CAP_USD = "200";
    process.env.SPEND_CAP_PER_USER_USD = "50";
  }
});

test("plafond global : un paiement du mois précédent ne soutient pas la dépense de ce mois-ci (seulement sa part de la moyenne sur 12 mois)", async () => {
  const before = (await budget.globalRevenueCapUsd())!;
  const now = new Date();
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 3600_000).toISOString().slice(0, 19).replace("T", " ");
  await revenue.recordPayment({ sourceId: "cs_prev", kind: "pack", paymentIntent: "pi_prev", userId: "prev", currency: "eur", amountCents: 120_000_00, feeCents: 0, paidAt: lastMonth });
  const rise = (await budget.globalRevenueCapUsd())! - before;
  // 0,6 × 120 000 $ / 12 = 6 000 $ au plus ; compté en entier, il en ferait 72 000.
  assert.ok(rise > 0 && rise <= 6000.01, `hausse ${rise}`);
});

test("AI_BUDGET_MARGIN=unlimited : pas de budget (déploiement qui ne le veut pas)", async () => {
  process.env.AI_BUDGET_MARGIN = "unlimited";
  try {
    await gift("nolimit", 4);
    assert.equal((await reserveQcm("nolimit")).ok, true);
  } finally {
    process.env.AI_BUDGET_MARGIN = "0.6";
  }
});

test("budget invérifiable (base indisponible) : refus propre 503, rien débité", async () => {
  await gift("down", 4);
  await authRun("ALTER TABLE llm_usage RENAME TO llm_usage_off");
  try {
    const r = await reserveQcm("down");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 503);
  } finally {
    await authRun("ALTER TABLE llm_usage_off RENAME TO llm_usage");
  }
  assert.equal(await credits.getBalanceCenti("down"), 400);
});
