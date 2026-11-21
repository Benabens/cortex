/**
 * CRÉDITS RENDUS APRÈS DÉPENSE = CRÉDITS OFFERTS (audit fuites B1, I3).
 * Pack offert par un code promo de la liste blanche : utilisable, borné par le plafond par crédit (21/11).
 *
 * Un job qui échoue est remboursé, mais si ses appels au modèle ont déjà coûté,
 * les crédits rendus ne sont plus « achetés » : le budget lié au revenu
 * (0,6 × revenu net) s'applique à eux. Sans cela, un pack de 9 € suffisait à
 * faire tourner l'IA en boucle (échec → remboursement → relance), chaque jour.
 * Un remboursement AVANT toute dépense (annulation au départ, double clic) rend
 * des crédits achetés, comme avant. La dépense d'un job échoué reste comptée.
 *
 * Seams : reserve.reserveGeneration (verdict), credits.refundGeneration.
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
  CREDITS_COST_JSON: JSON.stringify({ qcm: 2 }),
  AI_BUDGET_MARGIN: "0.6",
  AI_JOB_COST_USD_JSON: JSON.stringify({ qcm: 1, exam: 1, assist: 0.1 }),
  SPEND_CAP_PER_USER_USD: "unlimited",
  SPEND_CAP_USD: "100000",
  CORTEX_OWNER_USER_ID: "boss",
};
Object.assign(process.env, ENV);
// Aucun import statique du store : il lirait l'environnement avant l'affectation ci-dessus (imports remontés).

let reserve: typeof import("../lib/billing/reserve");
let credits: typeof import("../lib/billing/credits");
let usage: typeof import("../lib/billing/usage");
let authRun: typeof import("../db/auth-store").authRun;
let authGet: typeof import("../db/auth-store").authGet;
let nowStr: typeof import("../db/q").nowStr;
let handleStripeEvent: typeof import("../lib/billing/stripe-events").handleStripeEvent;

before(async () => {
  delete process.env.AI_BUDGET_FREE_USD;
  reserve = await import("../lib/billing/reserve");
  credits = await import("../lib/billing/credits");
  usage = await import("../lib/billing/usage");
  ({ authRun, authGet } = await import("../db/auth-store"));
  ({ nowStr } = await import("../db/q"));
  ({ handleStripeEvent } = await import("../lib/billing/stripe-events"));
});
beforeEach(() => usage.resetSpendCache());
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres?.();
  for (const k of Object.keys(ENV)) delete process.env[k];
});

const inMl = async <T,>(user: string, fn: () => Promise<T>) => {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  return runWithUser(user, () => runWithCourse("ml", fn));
};
let n = 0;
const reserveQcm = async (user: string) => {
  const ref = `job:${user}:ml:${++n}`;
  return { ref, r: await inMl(user, () => reserve.reserveGeneration({ bucket: "gen", kind: "qcm", costCenti: 200, ref, jobSlot: true })) };
};

/** Dépense IA réelle d'une réservation (llm_usage.credit_ref), comme l'écrit lib/llm. */
async function spendOn(user: string, ref: string, usd: number) {
  await authRun(
    `INSERT INTO llm_usage (user_id, course, provider, model, tokens_in, tokens_out, cost_usd, estimated, job_id, call_site, credit_ref, created_at)
     VALUES (?, 'ml', 'anthropic', 'claude-sonnet-5', 1000, 500, ?, 0, '1', 'qcm:generateBatch', ?, ?)`,
    user, usd, ref, nowStr(),
  );
}

/** Pack de 9 € payé (frais 38 c) : revenu net 8,62 $ → budget 5,17 $ ; 10 crédits achetés = 5 QCM. */
async function buyPack(user: string, id: string, amountCents = 900) {
  await handleStripeEvent({
    id: `evt_${id}`, type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: {
      id: `cs_${id}`, mode: "payment", payment_status: "paid", payment_intent: `pi_${id}`, amount_total: amountCents, currency: "eur",
      metadata: { cortexUserId: user, plan: "credits_10", credits: "10" },
    } },
  } as never, { lookup: { async sessionByPaymentIntent() { return null; }, async paymentDetails() { return { feeCents: 38 }; } } });
}

test("B1 : la boucle « échec après dépense → remboursement → relance » est arrêtée par le budget lié au revenu", async () => {
  await buyPack("looper", "loop1");
  let refused: Awaited<ReturnType<typeof reserveQcm>>["r"] | null = null;
  let launched = 0;
  for (let i = 0; i < 20 && !refused; i++) {
    const { ref, r } = await reserveQcm("looper");
    if (!r.ok) { refused = r; break; }
    launched++;
    await spendOn("looper", ref, 1);                        // le job a coûté 1 $ puis a échoué
    const back = await inMl("looper", () => credits.refundGeneration("qcm", ref));
    assert.equal(back, 200, "l'échec reste remboursé en entier");
  }
  assert.ok(refused, "la boucle doit s'arrêter");
  assert.equal(refused!.ok, false);
  assert.equal(!refused!.ok && refused!.status, 402);
  // 5 QCM couverts par les crédits achetés ; ensuite le budget (5,17 $) borne la dépense.
  assert.equal(launched, 5);
  const spent = Number((await authGet<{ s: number }>(`SELECT sum(cost_usd) s FROM llm_usage WHERE user_id = ?`, "looper"))?.s);
  assert.ok(spent <= 5.17 + 1, `dépense ${spent} $ bornée par le budget`);
  // Les crédits rendus restent au solde : rien n'est confisqué.
  assert.equal(await credits.getBalanceCenti("looper"), 1000);
});

test("B1 : un remboursement SANS dépense rend des crédits achetés (annulation au départ, double clic)", async () => {
  await buyPack("canceler", "cancel1");
  for (let i = 0; i < 8; i++) {
    const { ref, r } = await reserveQcm("canceler");
    assert.equal(r.ok, true, `lancement ${i + 1}`);
    await inMl("canceler", () => credits.refundGeneration("qcm", ref));
  }
  // Rien n'a coûté : les 10 crédits restent achetés, 5 QCM passent malgré une dépense ancienne hors budget.
  await authRun(
    `INSERT INTO llm_usage (user_id, course, provider, model, cost_usd, estimated, created_at) VALUES ('canceler', 'ml', 'anthropic', 'x', 20, 0, ?)`, nowStr(-2 * 86400_000),
  );
  for (let i = 0; i < 5; i++) { const x = (await reserveQcm("canceler")).r; assert.equal(x.ok, true, `QCM acheté ${i + 1} ${JSON.stringify(x)}`); }
});

test("B1 : part d'abonnement rendue après dépense → crédits offerts au registre, le solde du mois n'est pas rechargé", async () => {
  const end = new Date(Date.now() + 20 * 86400_000).toISOString().slice(0, 19).replace("T", " ");
  const start = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 19).replace("T", " ");
  await credits.grantSubscriptionMonth({ userId: "sub1", plan: "pro_monthly", periodEnd: end, periodStart: start });
  const sub0 = Number((await credits.getSubscription("sub1"))!.remaining);
  const { ref, r } = await reserveQcm("sub1");
  assert.equal(r.ok, true);
  await spendOn("sub1", ref, 1);
  assert.equal(await inMl("sub1", () => credits.refundGeneration("qcm", ref)), 200);
  assert.equal(Number((await credits.getSubscription("sub1"))!.remaining), sub0 - 200, "la part d'abonnement n'est pas rendue au mois");
  const offered = await authGet<{ s: number }>(`SELECT sum(delta) s FROM credit_transactions WHERE user_id = 'sub1' AND offered = 1`);
  assert.equal(Number(offered?.s), 200, "elle revient en crédits offerts");
  assert.equal(await credits.getBalanceCenti("sub1"), sub0, "solde total inchangé : 18 crédits du mois + 2 offerts");
  // Rejeu : idempotent.
  assert.equal(await inMl("sub1", () => credits.refundGeneration("qcm", ref)), 0);
  assert.equal(await credits.getBalanceCenti("sub1"), sub0);
});

/** Pack de 10 crédits payé 0 € avec un code promo (liste blanche ou non). */
async function promoPack(user: string, id: string, promo: string) {
  return handleStripeEvent({
    id: `evt_${id}`, type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: {
      id: `cs_${id}`, mode: "payment", payment_status: "no_payment_required", payment_intent: null, amount_total: 0, currency: "eur",
      discounts: [{ promotion_code: promo }],
      metadata: { cortexUserId: user, plan: "credits_10", credits: "10" },
    } },
  } as never, { lookup: { async sessionByPaymentIntent() { return null; }, async paymentDetails() { return { feeCents: 0 }; } } });
}

test("pack offert par un code de la liste blanche : la préparation passe et débite le solde", async () => {
  process.env.STRIPE_FREE_PROMO_CODES = "promo_free";
  try {
    await promoPack("promo", "free0", "promo_free");
    assert.equal(await credits.getBalanceCenti("promo"), 1000, "le pack promo est crédité");
    const ref = `job:promo:ml:prep`;
    const r = await inMl("promo", () => reserve.reserveGeneration({ bucket: "gen", kind: "prepare", costCenti: 200, ref, jobSlot: true }));
    assert.equal(r.ok, true, `préparation refusée : ${JSON.stringify(r)}`);
    assert.equal(await credits.getBalanceCenti("promo"), 800, "2 crédits débités");
    // Tout le pack se dépense : 4 QCM de 2 crédits après la préparation.
    for (let i = 0; i < 4; i++) assert.equal((await reserveQcm("promo")).r.ok, true, `QCM ${i + 1}`);
    assert.equal(await credits.getBalanceCenti("promo"), 0);
  } finally {
    delete process.env.STRIPE_FREE_PROMO_CODES;
  }
});

test("pack offert : la boucle « échec après dépense → remboursement → relance » coûte au plus crédits × plafond par crédit", async () => {
  process.env.STRIPE_FREE_PROMO_CODES = "promo_free";
  process.env.SPEND_CAP_PER_USER_FLOOR_USD = "1000";        // plafond du jour écarté : la borne par crédit tient seule
  try {
    await promoPack("promo-loop", "free1", "promo_free");
    const perCredit = usage.spendCapUsdPerCredit()!;
    let launched = 0;
    for (let i = 0; i < 20; i++) {
      const { ref, r } = await reserveQcm("promo-loop");
      if (!r.ok) { assert.equal(r.status, 402); break; }
      launched++;
      const cap = (await usage.reservationCapUsd(ref))!;
      await spendOn("promo-loop", ref, cap);                 // le job dépense tout son plafond puis échoue
      await inMl("promo-loop", () => credits.refundGeneration("qcm", ref));
    }
    assert.equal(launched, 5, "10 crédits offerts = 5 QCM, pas un de plus");
    const spent = Number((await authGet<{ s: number }>(`SELECT sum(cost_usd) s FROM llm_usage WHERE user_id = ?`, "promo-loop"))?.s);
    assert.ok(spent <= 10 * perCredit + 1e-9, `dépense ${spent} $ ≤ 10 × ${perCredit} $`);
  } finally {
    delete process.env.STRIPE_FREE_PROMO_CODES;
    delete process.env.SPEND_CAP_PER_USER_FLOOR_USD;
  }
});

test("pack offert, plafond par crédit levé (JOB_SPEND_CAP_USD_PER_CREDIT=unlimited) : plus de borne, il redevient soumis au budget", async () => {
  process.env.STRIPE_FREE_PROMO_CODES = "promo_free";
  try {
    await promoPack("promo-nocap", "free3", "promo_free");
    process.env.JOB_SPEND_CAP_USD_PER_CREDIT = "unlimited";
    const { r } = await reserveQcm("promo-nocap");
    assert.equal(r.ok, false, "sans plafond par crédit, le cadeau ne serait plus borné");
    assert.ok(!r.ok && ["billing_free_capacity_exhausted", "billing_free_budget_exceeded"].includes(r.code), `refusé comme crédit offert : ${!r.ok && r.code}`);
    delete process.env.JOB_SPEND_CAP_USD_PER_CREDIT;
    assert.equal((await reserveQcm("promo-nocap")).r.ok, true, "plafond rétabli : utilisable");
  } finally {
    delete process.env.STRIPE_FREE_PROMO_CODES;
    delete process.env.JOB_SPEND_CAP_USD_PER_CREDIT;
  }
});

test("pack à 0 € avec un code HORS liste blanche : toujours aucun crédit", async () => {
  process.env.STRIPE_FREE_PROMO_CODES = "promo_free";
  try {
    const res = await promoPack("promo-out", "free2", "promo_autre");
    assert.equal(res.credited, false);
    assert.equal(await credits.getBalanceCenti("promo-out"), 0);
    assert.equal((await reserveQcm("promo-out")).r.ok, false);
  } finally {
    delete process.env.STRIPE_FREE_PROMO_CODES;
  }
});

test("I3 : crédits du relecteur (review_grant) : restent utilisables, accordés à la main et bornés par le script", async () => {
  await credits.addTransaction("reviewer", 1000, "review_grant", "review_grant:reviewer:1");
  assert.equal((await reserveQcm("reviewer")).r.ok, true);
});
