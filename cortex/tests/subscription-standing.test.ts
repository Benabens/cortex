/**
 * ÉTAT D'UN ABONNEMENT vu de l'app — une seule lecture (`standingOf`) pour les
 * crédits, l'écran « Abonnement & crédits » et la garde d'achat :
 *  - live      : période payée en cours, en règle → donne des crédits ;
 *  - renewing  : en règle, période payée tout juste échue → Stripe encaisse le
 *                renouvellement (une heure environ), rien n'est encore dû ;
 *  - unpaid    : Stripe n'a pas pu encaisser (past_due, unpaid, incomplete, paused) ;
 *  - suspended : facture remboursée ou contestée, jusqu'à la prochaine facture payée ;
 *  - none      : pas d'abonnement, ou terminé.
 * Tant que Stripe tient un abonnement pour vivant (tout sauf none), on n'en
 * ouvre pas un second : il facturerait en double. Logique pure, sans base.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { nextRechargeDate, secondSubscriptionRefusal, standingOf, type WindowedSub } from "../lib/billing/subscription-windows";

const NOW = "2026-10-28 11:00:00";
const sub = (over: Partial<WindowedSub> = {}): WindowedSub => ({
  plan: "cortex_pro_monthly", status: "active", suspended: 0,
  period_start: "2026-10-01 10:00:00", period_end: "2026-11-01 10:00:00",
  month_anchor: "2026-10", window_anchor: "2026-10-01 10:00:00",
  status_at: "2026-10-01 10:00:00", updated_at: "2026-10-01 10:00:00", cancel_at_period_end: 0,
  ...over,
});

test("standingOf : période payée en cours et en règle → live ; résiliation programmée comprise", () => {
  assert.equal(standingOf(sub(), NOW), "live");
  assert.equal(standingOf(sub({ status: "trialing" }), NOW), "live");
  assert.equal(standingOf(sub({ cancel_at_period_end: 1 }), NOW), "live", "résiliation programmée : en règle jusqu'à la fin de la période payée");
});

test("standingOf : pas de ligne, résilié ou jamais abouti → none", () => {
  assert.equal(standingOf(undefined, NOW), "none");
  assert.equal(standingOf(null, NOW), "none");
  assert.equal(standingOf(sub({ status: "canceled" }), NOW), "none");
  assert.equal(standingOf(sub({ status: "incomplete_expired" }), NOW), "none");
});

test("standingOf : Stripe n'a pas encaissé → unpaid, même dans une période payée", () => {
  for (const status of ["past_due", "unpaid", "incomplete", "paused"]) {
    assert.equal(standingOf(sub({ status }), NOW), "unpaid", status);
    assert.equal(standingOf(sub({ status, period_end: "2026-10-28 10:00:00" }), NOW), "unpaid", `${status}, période échue`);
  }
});

test("standingOf : facture reprise (remboursement, litige) dans la période → suspended", () => {
  assert.equal(standingOf(sub({ suspended: 1 }), NOW), "suspended");
});

test("standingOf : en règle mais période payée échue → renewing pendant trois jours, puis none", () => {
  const ended = sub({ period_end: "2026-10-28 10:00:00" });
  assert.equal(standingOf(ended, "2026-10-28 10:00:00"), "renewing", "à l'instant de l'échéance");
  assert.equal(standingOf(ended, NOW), "renewing", "une heure après : facture en brouillon chez Stripe");
  assert.equal(standingOf(ended, "2026-10-31 09:59:59"), "renewing");
  assert.equal(standingOf(ended, "2026-10-31 10:00:00"), "none", "aucune facture payée en trois jours : abonnement tenu pour terminé");
  // Checkout abouti, première facture pas encore traitée : aucune période encore.
  const linked = sub({ period_start: null, period_end: null, window_anchor: null, month_anchor: null, status_at: "2026-10-28 10:59:50" });
  assert.equal(standingOf(linked, NOW), "renewing", "activation en cours");
  assert.equal(standingOf({ ...linked, status_at: null, updated_at: "2026-10-01 10:00:00" }, NOW), "none");
});

test("second abonnement : refusé tant que Stripe tient le premier pour vivant, avec la marche à suivre", () => {
  assert.equal(secondSubscriptionRefusal("none"), null);
  assert.match(secondSubscriptionRefusal("live") ?? "", /déjà un abonnement/);
  assert.match(secondSubscriptionRefusal("renewing") ?? "", /renouvellement/);
  assert.match(secondSubscriptionRefusal("unpaid") ?? "", /moyen de paiement/);
  assert.match(secondSubscriptionRefusal("suspended") ?? "", /suspendu/);
});

test("prochaine recharge affichée : aucune pour un mensuel dont la résiliation est programmée ; l'annuel garde ses fenêtres payées", () => {
  assert.equal(nextRechargeDate(sub(), NOW), "2026-11-01", "mensuel : à la prochaine facture");
  assert.equal(nextRechargeDate(sub({ cancel_at_period_end: 1 }), NOW), null, "mensuel résilié : plus de facture, plus de recharge");
  const yearly = sub({ plan: "cortex_pro_yearly", period_start: "2026-10-01 10:00:00", period_end: "2027-10-01 10:00:00" });
  assert.equal(nextRechargeDate(yearly, NOW), "2026-11-01");
  assert.equal(nextRechargeDate({ ...yearly, cancel_at_period_end: 1 }, NOW), "2026-11-01", "annuel résilié : les mois déjà payés restent dus");
  assert.equal(nextRechargeDate({ ...yearly, cancel_at_period_end: 1 }, "2027-09-15 10:00:00"), null, "dernière fenêtre : rien après la fin de période");
  assert.equal(nextRechargeDate(sub({ status: "past_due" }), NOW), null);
});
