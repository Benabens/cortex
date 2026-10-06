/**
 * ABONNEMENT IMPAYÉ — la règle : les crédits d'abonnement viennent d'une
 * période PAYÉE, et de rien d'autre.
 *  - Seule une facture payée (invoice.paid) ouvre une période et remet le mois
 *    à 20 (jamais +20 : le reliquat est perdu).
 *  - Un renouvellement que Stripe annonce (customer.subscription.updated) sans
 *    l'avoir encaissé n'ouvre rien : ni reliquat du mois précédent pour un
 *    mensuel, ni nouvelle fenêtre pour un annuel.
 *  - Un abonnement qui n'est pas en règle (past_due, unpaid, paused…) ne donne
 *    aucun crédit d'abonnement, même dans une période déjà payée.
 *  - Les crédits achetés (packs) et les crédits offerts restent acquis.
 * Seams : handleStripeEvent, credits.subscriptionCreditsCenti / getBalanceCenti /
 * getSubscription, reserve.reserveGeneration. Store Postgres/PGlite en mémoire ;
 * unités en centièmes ; horloge simulée par scénario.
 */
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "0";
process.env.DAILY_GEN_QUOTA = "unlimited";
process.env.DAILY_ASSIST_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.MAX_ACTIVE_JOBS = "unlimited";

import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";

const inMl = <T,>(user: string, fn: () => Promise<T>) => runWithUser(user, () => runWithCourse("ml", fn));
const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (id: string, type: string, createdIso: string, object: unknown): any => ({ id, type, created: unix(createdIso), data: { object } });

type Plan = "cortex_pro_monthly" | "cortex_pro_yearly";
/** Facture d'abonnement PAYÉE pour la période [start, end), émise à `at` (défaut : début de période). */
const invoicePaid = (id: string, user: string, plan: Plan, start: string, end: string, at = start) =>
  ev(`evt_${id}`, "invoice.paid", at, {
    id: `in_${id}`, customer: `cus_${user}`, subscription: `sub_${user}`, payment_intent: `pi_${id}`,
    subscription_details: { metadata: { app: "cortex", cortexUserId: user } },
    lines: { data: [{ period: { start: unix(start), end: unix(end) }, price: { lookup_key: plan } }] },
  });
/** customer.subscription.updated : statut + période annoncée par Stripe (format récent : sur l'item). */
const subUpdated = (id: string, user: string, status: string, at: string, period?: { start: string; end: string }) =>
  ev(`evt_${id}`, "customer.subscription.updated", at, {
    id: `sub_${user}`, customer: `cus_${user}`, status, metadata: { app: "cortex", cortexUserId: user },
    items: { data: [period ? { current_period_start: unix(period.start), current_period_end: unix(period.end) } : {}] },
  });

/** Horloge simulée le temps d'un scénario daté, puis rendue. */
async function withClock(startIso: string, scenario: (at: (iso: string) => void) => Promise<void>): Promise<void> {
  mock.timers.enable({ apis: ["Date"], now: new Date(startIso).getTime() });
  try {
    await scenario((iso) => mock.timers.setTime(new Date(iso).getTime()));
  } finally {
    mock.timers.reset();
  }
}

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_GEN_QUOTA", "DAILY_ASSIST_QUOTA", "RATE_LIMIT_PER_USER_MIN", "MAX_ACTIVE_JOBS"]) delete process.env[k];
});

test("ANNUEL renouvelé sans paiement : aucun crédit, aucune fenêtre, tant que la facture n'est pas payée", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  await withClock("2026-03-15T10:00:00Z", async (at) => {
    await handleStripeEvent(invoicePaid("y1", "yunpaid", "cortex_pro_yearly", "2026-03-15T10:00:00Z", "2027-03-15T10:00:00Z"));
    assert.equal(await credits.subscriptionCreditsCenti("yunpaid"), 2000, "année payée : 20 crédits");

    at("2027-03-15T10:00:00Z");
    assert.equal(await credits.subscriptionCreditsCenti("yunpaid"), 0, "année échue");
    // Stripe avance la période et passe l'abonnement en retard de paiement : aucune facture payée.
    await handleStripeEvent(subUpdated("y1_pastdue", "yunpaid", "past_due", "2027-03-15T11:05:00Z", { start: "2027-03-15T10:00:00Z", end: "2028-03-15T10:00:00Z" }));
    at("2027-03-15T11:06:00Z");
    assert.equal(await credits.subscriptionCreditsCenti("yunpaid"), 0, "impayé : rien");
    const refused = await inMl("yunpaid", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: "job:yunpaid:ml:1" }));
    assert.equal(refused.ok, false, "aucune génération financée par un abonnement impayé");
    assert.equal((refused as { status: number }).status, 402);

    at("2027-04-15T10:00:01Z");
    assert.equal(await credits.subscriptionCreditsCenti("yunpaid"), 0, "un mois plus tard, toujours impayé : pas de fenêtre");

    // Le paiement finit par passer : la facture ouvre l'année, à 20 (pas de rattrapage des mois impayés).
    await handleStripeEvent(invoicePaid("y2", "yunpaid", "cortex_pro_yearly", "2027-03-15T10:00:00Z", "2028-03-15T10:00:00Z", "2027-04-16T09:00:00Z"));
    at("2027-04-16T09:00:01Z");
    assert.equal(await credits.subscriptionCreditsCenti("yunpaid"), 2000, "facture payée : 20 crédits");
    assert.equal((await credits.getSubscription("yunpaid"))?.status, "active");
  });
});

test("MENSUEL renouvelé sans paiement : le reliquat du mois précédent ne redevient pas utilisable", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  await withClock("2026-09-28T10:00:00Z", async (at) => {
    await handleStripeEvent(invoicePaid("m1", "munpaid", "cortex_pro_monthly", "2026-09-28T10:00:00Z", "2026-10-28T10:00:00Z"));
    assert.equal((await inMl("munpaid", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: "job:munpaid:ml:1" }))).ok, true);
    assert.equal(await credits.subscriptionCreditsCenti("munpaid"), 1800, "20 − 2");

    at("2026-10-28T10:00:00Z");
    await handleStripeEvent(subUpdated("m1_pastdue", "munpaid", "past_due", "2026-10-28T11:05:00Z", { start: "2026-10-28T10:00:00Z", end: "2026-11-28T10:00:00Z" }));
    at("2026-10-28T11:06:00Z");
    assert.equal(await credits.subscriptionCreditsCenti("munpaid"), 0, "les 18 crédits restants du mois payé ne sont pas reportés sur un mois impayé");
    assert.equal(await credits.getBalanceCenti("munpaid"), 0);
  });
});

test("renouvellement ANNONCÉ mais pas encore encaissé (statut encore active) : rien avant la facture payée, puis 20 et non 20 + reliquat", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  await withClock("2026-09-28T10:00:00Z", async (at) => {
    for (const [user, plan, end] of [["mdraft", "cortex_pro_monthly", "2026-10-28T10:00:00Z"], ["ydraft", "cortex_pro_yearly", "2027-09-28T10:00:00Z"]] as const) {
      at("2026-09-28T10:00:00Z");
      await handleStripeEvent(invoicePaid(`${user}_1`, user, plan, "2026-09-28T10:00:00Z", end));
      assert.equal((await inMl(user, () => reserveGeneration({ bucket: "gen", kind: "exam", ref: `job:${user}:ml:1` }))).ok, true);
      // À l'échéance, Stripe avance la période et laisse la facture en brouillon une heure : statut encore « active ».
      const next = user === "mdraft" ? "2026-11-28T10:00:00Z" : "2028-09-28T10:00:00Z";
      at(end);
      await handleStripeEvent(subUpdated(`${user}_draft`, user, "active", end, { start: end, end: next }));
      assert.equal(await credits.subscriptionCreditsCenti(user), 0, `${user} : période annoncée, pas payée`);
      assert.equal((await inMl(user, () => reserveGeneration({ bucket: "gen", kind: "exam", ref: `job:${user}:ml:2` }))).ok, false);
      // Une heure plus tard le paiement passe.
      const paidAt = new Date(new Date(end).getTime() + 3600_000).toISOString();
      at(paidAt);
      await handleStripeEvent(invoicePaid(`${user}_2`, user, plan, end, next, paidAt));
      assert.equal(await credits.subscriptionCreditsCenti(user), 2000, `${user} : remis à 20, le reliquat de 18 est perdu`);
    }
  });
});

test("ANNUEL hérité (ancre calendaire seule) : un subscription.updated n'ouvre pas un second lot dans le mois", async () => {
  const credits = await import("../lib/billing/credits");
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  const { authRun } = await import("../db/auth-store");
  await withClock("2026-09-28T12:00:00Z", async (at) => {
    // Ligne écrite avant les fenêtres : annuel facturé un 15/03, septembre ouvert au 1er, 3 crédits restants.
    await authRun(
      `INSERT INTO subscriptions (user_id, customer_id, subscription_id, status, plan, monthly_credits, remaining, period_end, month_anchor, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      "ylegacy", "cus_ylegacy", "sub_ylegacy", "active", "cortex_pro_yearly", 2000, 300, "2027-03-15 10:00:00", "2026-09", "2026-09-01 08:00:00",
    );
    assert.equal(await credits.subscriptionCreditsCenti("ylegacy"), 300);
    await handleStripeEvent(subUpdated("ylegacy_up", "ylegacy", "active", "2026-09-28T12:00:00Z", { start: "2026-03-15T10:00:00Z", end: "2027-03-15T10:00:00Z" }));
    assert.equal(await credits.subscriptionCreditsCenti("ylegacy"), 300, "même période, aucune facture : pas de recharge");
    at("2026-10-01T00:00:00Z");
    assert.equal(await credits.subscriptionCreditsCenti("ylegacy"), 2000, "la recharge reste celle du 1er du mois, une fois");
    at("2026-10-15T10:00:01Z");
    assert.equal(await credits.subscriptionCreditsCenti("ylegacy"), 2000, "le 15 n'ouvre pas une seconde fenêtre en octobre");
  });
});

test("abonnement plus en règle PENDANT une période payée : aucun crédit ni fenêtre ; de retour en règle, la période payée reprend", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  await withClock("2026-03-15T10:00:00Z", async (at) => {
    await handleStripeEvent(invoicePaid("ys1", "ystanding", "cortex_pro_yearly", "2026-03-15T10:00:00Z", "2027-03-15T10:00:00Z"));
    assert.equal((await inMl("ystanding", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: "job:ystanding:ml:1" }))).ok, true);
    for (const status of ["past_due", "unpaid", "paused", "incomplete"]) {
      at("2026-04-01T09:00:00Z");
      await handleStripeEvent(subUpdated(`ys_${status}`, "ystanding", status, "2026-04-01T09:00:00Z"));
      assert.equal(await credits.subscriptionCreditsCenti("ystanding"), 0, `${status} : aucun crédit d'abonnement`);
      // Le 15/04 une fenêtre s'ouvrirait pour un annuel en règle.
      at("2026-04-15T10:00:01Z");
      assert.equal(await credits.subscriptionCreditsCenti("ystanding"), 0, `${status} : pas de fenêtre`);
      assert.equal((await inMl("ystanding", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: `job:ystanding:ml:${status}` }))).ok, false);
      assert.equal((await credits.getSubscription("ystanding"))?.remaining, 1800, `${status} : la réservation refusée n'a rien rechargé`);
    }
    await handleStripeEvent(subUpdated("ys_back", "ystanding", "active", "2026-04-15T11:00:00Z"));
    at("2026-04-15T11:00:01Z");
    assert.equal(await credits.subscriptionCreditsCenti("ystanding"), 2000, "de retour en règle : la fenêtre du 15/04 de l'année payée s'ouvre");
  });
});

test("événement de statut livré EN RETARD : un « past_due » antérieur au paiement ne rétrograde pas l'abonné qui a payé", async () => {
  const credits = await import("../lib/billing/credits");
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  await withClock("2026-09-28T10:00:00Z", async (at) => {
    await handleStripeEvent(invoicePaid("late1", "late", "cortex_pro_monthly", "2026-09-28T10:00:00Z", "2026-10-28T10:00:00Z"));
    // 28/10 : le paiement échoue à 11 h (événement past_due émis, mais sa livraison échoue et Stripe la rejouera),
    // l'abonné corrige sa carte et paie à 12 h.
    at("2026-10-28T12:00:00Z");
    await handleStripeEvent(invoicePaid("late2", "late", "cortex_pro_monthly", "2026-10-28T10:00:00Z", "2026-11-28T10:00:00Z", "2026-10-28T12:00:00Z"));
    assert.equal(await credits.subscriptionCreditsCenti("late"), 2000);
    // 13 h : Stripe rejoue l'événement de 11 h.
    at("2026-10-28T13:00:00Z");
    await handleStripeEvent(subUpdated("late_pastdue", "late", "past_due", "2026-10-28T11:00:00Z"));
    assert.equal((await credits.getSubscription("late"))?.status, "active", "le statut suit l'événement le plus récent, pas le dernier arrivé");
    assert.equal(await credits.subscriptionCreditsCenti("late"), 2000, "l'abonné qui a payé garde ses crédits");
    // Un vrai retard de paiement, postérieur, s'applique.
    await handleStripeEvent(subUpdated("late_pastdue_real", "late", "past_due", "2026-10-28T13:30:00Z"));
    assert.equal(await credits.subscriptionCreditsCenti("late"), 0);
  });
});

test("crédits achetés et crédits offerts : acquis, quel que soit l'état de l'abonnement", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  await withClock("2026-09-28T10:00:00Z", async (at) => {
    await handleStripeEvent(invoicePaid("p1", "packs", "cortex_pro_monthly", "2026-09-28T10:00:00Z", "2026-10-28T10:00:00Z"));
    await credits.addTransaction("packs", 200, "signup", "signup:packs");                 // 2 crédits offerts
    await handleStripeEvent(ev("evt_packs_cs", "checkout.session.completed", "2026-09-29T10:00:00Z", {
      id: "cs_packs", mode: "payment", payment_status: "paid", amount_total: 900, payment_intent: "pi_packs_cs", customer: "cus_packs_pack",
      metadata: { app: "cortex", cortexUserId: "packs", plan: "credits_10", credits: "10" },
    }));
    assert.equal(await credits.getBalanceCenti("packs"), 2000 + 200 + 1000);

    at("2026-10-28T11:05:00Z");
    await handleStripeEvent(subUpdated("packs_pastdue", "packs", "past_due", "2026-10-28T11:05:00Z", { start: "2026-10-28T10:00:00Z", end: "2026-11-28T10:00:00Z" }));
    assert.equal(await credits.subscriptionCreditsCenti("packs"), 0, "abonnement impayé : ses 20 crédits sont perdus");
    assert.equal(await credits.purchasedBalanceCenti("packs"), 1200, "2 offerts + 10 achetés : intacts");
    const r = await inMl("packs", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: "job:packs:ml:1" }));
    assert.equal(r.ok, true, "une génération reste payable avec les crédits achetés");
    assert.equal(await credits.purchasedBalanceCenti("packs"), 1000);
  });
});

// ─────────────── reprise d'une facture pendant que l'abonnement n'est pas en règle ───────────────

/** Remboursement intégral du paiement d'une facture d'abonnement (le pi_ est celui de invoicePaid). */
const refunded = (id: string, user: string, at: string) =>
  ev(`evt_refund_${id}`, "charge.refunded", at, { payment_intent: `pi_${id}`, amount: 1490, amount_refunded: 1490, customer: `cus_${user}` });

test("facture remboursée pendant un impayé : seuls les crédits réellement consommés deviennent une dette, les crédits achetés restent", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  await withClock("2026-09-28T10:00:00Z", async (at) => {
    // « rien » : rien consommé du mois ; « six » : 6 crédits consommés (3 examens). Tous deux ont 10 crédits achetés.
    for (const [user, exams] of [["rf-rien", 0], ["rf-six", 3]] as const) {
      at("2026-09-28T10:00:00Z");
      await handleStripeEvent(invoicePaid(`${user}_1`, user, "cortex_pro_monthly", "2026-09-28T10:00:00Z", "2026-10-28T10:00:00Z"));
      await credits.addTransaction(user, 1000, "achat credits_10", `stripe:cs:cs_${user}`);
      for (let i = 0; i < exams; i++) {
        assert.equal((await inMl(user, () => reserveGeneration({ bucket: "gen", kind: "exam", ref: `job:${user}:ml:${i}` }))).ok, true);
      }
      // Échéance, le renouvellement échoue ; puis le mois PAYÉ (le précédent) est remboursé.
      at("2026-10-28T11:05:00Z");
      await handleStripeEvent(subUpdated(`${user}_pastdue`, user, "past_due", "2026-10-28T11:05:00Z", { start: "2026-10-28T10:00:00Z", end: "2026-11-28T10:00:00Z" }));
      await handleStripeEvent(refunded(`${user}_1`, user, "2026-10-29T09:00:00Z"));
      const consumed = exams * 200;
      assert.equal(await credits.purchasedBalanceCenti(user), 1000 - consumed, `${user} : dette = ${consumed} centièmes consommés, pas les 2000 du mois`);
      assert.equal(await credits.subscriptionCreditsCenti(user), 0);
    }
  });
});

// ─────────────── la période payée se lit sur la bonne ligne, et ne recule jamais ───────────────

test("facture à plusieurs lignes (prorata d'un changement d'offre en tête) : la période est celle de la ligne d'abonnement, pas du prorata", async () => {
  const credits = await import("../lib/billing/credits");
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  await withClock("2026-10-10T10:00:00Z", async () => {
    await handleStripeEvent(invoicePaid("ml1", "multiline", "cortex_pro_monthly", "2026-09-28T10:00:00Z", "2026-10-28T10:00:00Z"));
    // Passage mensuel → annuel le 10/10 : crédit du temps non utilisé (prorata, période résiduelle de l'ancienne offre) PUIS la nouvelle offre.
    await handleStripeEvent(ev("evt_ml2", "invoice.paid", "2026-10-10T10:00:00Z", {
      id: "in_ml2", customer: "cus_multiline", subscription: "sub_multiline", payment_intent: "pi_ml2",
      subscription_details: { metadata: { app: "cortex", cortexUserId: "multiline" } },
      lines: { data: [
        { proration: true, amount: -894, period: { start: unix("2026-10-10T10:00:00Z"), end: unix("2026-10-28T10:00:00Z") }, price: { lookup_key: "cortex_pro_monthly" } },
        { proration: false, amount: 11900, period: { start: unix("2026-10-10T10:00:00Z"), end: unix("2027-10-10T10:00:00Z") }, price: { lookup_key: "cortex_pro_yearly" } },
      ] },
    }));
    const s = await credits.getSubscription("multiline");
    assert.equal(s?.period_end, "2027-10-10 10:00:00", "fin de la période de la nouvelle offre");
    assert.equal(s?.plan, "cortex_pro_yearly");
    // Format récent : le prorata est signalé sous parent.subscription_item_details.
    await handleStripeEvent(ev("evt_ml3", "invoice.paid", "2026-10-10T10:00:00Z", {
      id: "in_ml3", customer: "cus_multiline2", parent: { subscription_details: { subscription: "sub_multiline2", metadata: { app: "cortex", cortexUserId: "multiline2" } } },
      lines: { data: [
        { parent: { subscription_item_details: { proration: true, subscription: "sub_multiline2" } }, period: { start: unix("2026-10-10T10:00:00Z"), end: unix("2026-10-28T10:00:00Z") }, price: { lookup_key: "cortex_pro_monthly" } },
        { parent: { subscription_item_details: { proration: false, subscription: "sub_multiline2" } }, period: { start: unix("2026-10-10T10:00:00Z"), end: unix("2027-10-10T10:00:00Z") }, price: { lookup_key: "cortex_pro_yearly" } },
      ] },
    }));
    assert.equal((await credits.getSubscription("multiline2"))?.period_end, "2027-10-10 10:00:00");
  });
});

test("facture ANCIENNE payée après une plus récente : la période payée ne recule pas, l'abonné garde son mois en cours", async () => {
  const credits = await import("../lib/billing/credits");
  const { reserveGeneration } = await import("../lib/billing/reserve");
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  const { authGet } = await import("../db/auth-store");
  await withClock("2026-11-28T12:00:00Z", async () => {
    // Octobre est resté impayé, novembre aussi ; la carte est corrigée le 28/11 : Stripe encaisse les deux factures, la plus récente d'abord.
    await handleStripeEvent(invoicePaid("old3", "catchup", "cortex_pro_monthly", "2026-11-28T10:00:00Z", "2026-12-28T10:00:00Z", "2026-11-28T12:00:00Z"));
    assert.equal((await inMl("catchup", () => reserveGeneration({ bucket: "gen", kind: "exam", ref: "job:catchup:ml:1" }))).ok, true);
    await handleStripeEvent(invoicePaid("old2", "catchup", "cortex_pro_monthly", "2026-10-28T10:00:00Z", "2026-11-28T10:00:00Z", "2026-11-28T12:00:05Z"));
    const s = await credits.getSubscription("catchup");
    assert.equal(s?.period_end, "2026-12-28 10:00:00", "la période reste celle de la facture la plus récente");
    assert.equal(await credits.subscriptionCreditsCenti("catchup"), 1800, "ni remise à 20, ni perte du mois en cours");
    assert.ok(await authGet(`SELECT invoice_id FROM stripe_invoices WHERE invoice_id = ?`, "in_old2"), "la facture ancienne reste enregistrée (reprise possible en cas de remboursement)");
  });
});
