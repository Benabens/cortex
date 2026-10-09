/**
 * RAPPEL DE RECONDUCTION (art. L215-1 C. conso) — À QUI et QUAND, logique pure.
 * La loi : au plus tôt trois mois et au plus tard un mois avant la date limite
 * de non-reconduction. La règle de Cortex : à partir de 60 jours avant
 * l'échéance payée, et tant qu'il reste plus de 30 jours ET plus d'un mois
 * calendaire. Seuls les abonnements annuels que Stripe reconduira sont visés.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { reminderVerdict, type ReminderSub } from "../lib/billing/renewal-reminders";

const sub = (over: Partial<ReminderSub> = {}): ReminderSub => ({
  subscription_id: "sub_1", plan: "cortex_pro_yearly", status: "active",
  period_start: "2026-10-07 12:00:00", period_end: "2027-10-07 12:00:00", cancel_at_period_end: 0,
  ...over,
});

test("fenêtre : rien avant 60 jours, dû ensuite, trop tard à 30 jours de l'échéance", () => {
  assert.equal(reminderVerdict(sub(), "2026-10-09 09:00:00"), "too-early", "abonnement tout neuf");
  assert.equal(reminderVerdict(sub(), "2027-08-08 11:59:59"), "too-early", "une seconde avant J-60");
  assert.equal(reminderVerdict(sub(), "2027-08-08 12:00:00"), "due", "J-60");
  assert.equal(reminderVerdict(sub(), "2027-09-01 08:00:00"), "due", "rattrapage : encore 36 jours");
  assert.equal(reminderVerdict(sub(), "2027-09-07 11:59:59"), "due", "il reste 30 jours et une seconde");
  assert.equal(reminderVerdict(sub(), "2027-09-07 12:00:00"), "too-late", "30 jours pile : plus « plus de 30 jours »");
  assert.equal(reminderVerdict(sub(), "2027-10-08 00:00:00"), "too-late", "échéance passée");
});

test("fenêtre : un MOIS calendaire avant l'échéance, pas seulement 30 jours", () => {
  // Échéance le 31 août : un mois avant = le 31 juillet, soit 31 jours.
  const aug = sub({ period_start: "2026-08-31 12:00:00", period_end: "2027-08-31 12:00:00" });
  assert.equal(reminderVerdict(aug, "2027-07-31 11:59:59"), "due");
  assert.equal(reminderVerdict(aug, "2027-07-31 18:00:00"), "too-late", "30 jours et 18 h restants, mais moins d'un mois calendaire");
  // Échéance le 15 mars : un mois avant = le 15 février (28 jours) ; c'est la règle des 30 jours qui borne.
  const mar = sub({ period_start: "2026-03-15 12:00:00", period_end: "2027-03-15 12:00:00" });
  assert.equal(reminderVerdict(mar, "2027-02-13 11:59:59"), "due");
  assert.equal(reminderVerdict(mar, "2027-02-14 00:00:00"), "too-late");
});

test("seul un abonnement ANNUEL est visé : le mensuel ne reçoit jamais de rappel", () => {
  const monthly = sub({ plan: "cortex_pro_monthly", period_start: "2027-08-08 12:00:00", period_end: "2027-09-08 12:00:00" });
  for (const now of ["2027-08-08 12:00:00", "2027-08-20 12:00:00", "2027-09-08 11:00:00"]) {
    assert.equal(reminderVerdict(monthly, now), "not-yearly", now);
  }
  // Le plan posé par le checkout (clé d'offre) vaut la lookup_key posée par la facture.
  assert.equal(reminderVerdict(sub({ plan: "pro_yearly" }), "2027-08-20 12:00:00"), "due");
  // Plan inconnu : c'est la durée de la période payée qui tranche.
  assert.equal(reminderVerdict(sub({ plan: null }), "2027-08-20 12:00:00"), "due");
});

test("pas de reconduction à annoncer : résiliation programmée, abonnement terminé, ligne sans période", () => {
  const now = "2027-08-20 12:00:00";
  assert.equal(reminderVerdict(sub({ cancel_at_period_end: 1 }), now), "not-renewing", "résiliation programmée en fin de période");
  assert.equal(reminderVerdict(sub({ status: "canceled" }), now), "not-renewing");
  assert.equal(reminderVerdict(sub({ status: "incomplete_expired" }), now), "not-renewing");
  assert.equal(reminderVerdict(sub({ period_end: null }), now), "not-renewing", "checkout abouti, aucune facture payée");
  assert.equal(reminderVerdict(sub({ subscription_id: null }), now), "not-renewing");
});

test("tant que Stripe tient l'abonnement pour vivant il se reconduira : le rappel reste dû (impayé, suspendu)", () => {
  const now = "2027-08-20 12:00:00";
  assert.equal(reminderVerdict(sub({ status: "past_due" }), now), "due");
  assert.equal(reminderVerdict(sub({ status: "trialing" }), now), "due");
});
