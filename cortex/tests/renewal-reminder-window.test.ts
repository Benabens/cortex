/**
 * RAPPEL DE RECONDUCTION (art. L215-1 C. conso) — À QUI et QUAND, logique pure.
 * La loi : au plus tôt trois mois et au plus tard un mois avant la date limite
 * de non-reconduction. La règle de Cortex : à partir de 60 jours avant
 * l'échéance payée, tant qu'il reste plus de 30 jours ET que le jour d'envoi
 * précède d'au moins un mois calendaire la date limite que l'e-mail annonce (la
 * veille de l'échéance, heure de Paris). Seuls les abonnements annuels que
 * Stripe reconduira sont visés.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { reminderVerdict, renewalReminderEmail, type ReminderSub } from "../lib/billing/renewal-reminders";

const sub = (over: Partial<ReminderSub> = {}): ReminderSub => ({
  subscription_id: "sub_1", plan: "cortex_pro_yearly", status: "active",
  period_start: "2026-10-07 12:00:00", period_end: "2027-10-07 12:00:00", cancel_at_period_end: 0,
  ...over,
});

test("fenêtre : rien avant 60 jours, dû ensuite, trop tard un mois avant la date limite annoncée", () => {
  // Échéance le 7 octobre 2027 à 14 h (Paris) : date limite annoncée le 6 octobre, dernier jour d'envoi le 6 septembre.
  assert.equal(reminderVerdict(sub(), "2026-10-09 09:00:00"), "too-early", "abonnement tout neuf");
  assert.equal(reminderVerdict(sub(), "2027-08-08 11:59:59"), "too-early", "une seconde avant J-60");
  assert.equal(reminderVerdict(sub(), "2027-08-08 12:00:00"), "due", "J-60");
  assert.equal(reminderVerdict(sub(), "2027-09-01 08:00:00"), "due", "rattrapage : encore 36 jours");
  assert.equal(reminderVerdict(sub(), "2027-09-06 21:59:59"), "due", "le 6 septembre à 23 h 59 (Paris) : un mois avant la limite");
  assert.equal(reminderVerdict(sub(), "2027-09-06 22:00:00"), "too-late", "le 7 septembre (Paris) : moins d'un mois avant le 6 octobre");
  assert.equal(reminderVerdict(sub(), "2027-09-07 07:00:00"), "too-late", "le passage du 7 septembre au matin serait hors délai");
  assert.equal(reminderVerdict(sub(), "2027-10-08 00:00:00"), "too-late", "échéance passée");
});

test("fenêtre et encadré comptent depuis la même date : la veille de l'échéance, heure de Paris", () => {
  // [échéance UTC, date limite de l'encadré, dernier instant où l'envoi est dans les temps, premier instant hors délai]
  const cases: Array<[string, string, string, string, string]> = [
    ["2027-10-07 22:30:00", "7 octobre 2027", "2027-09-07 21:59:59", "2027-09-07 22:00:00", "reconduction le 8 à 0 h 30 (Paris) : limite le 7, envoi jusqu'au 7 septembre"],
    ["2027-08-31 12:00:00", "30 août 2027", "2027-07-30 21:59:59", "2027-07-30 22:00:00", "un mois avant le 30 août : le 30 juillet (32 jours avant l'échéance)"],
    ["2027-11-01 12:00:00", "31 octobre 2027", "2027-09-30 21:59:59", "2027-09-30 22:00:00", "un mois avant le 31 octobre : le 30 septembre, dernier jour du mois"],
    ["2028-03-31 10:00:00", "30 mars 2028", "2028-02-29 22:59:59", "2028-02-29 23:00:00", "année bissextile : un mois avant le 30 mars, c'est le 29 février"],
    ["2027-03-15 12:00:00", "14 mars 2027", "2027-02-13 11:59:59", "2027-02-13 12:00:00", "février : le mois ne fait que 28 jours, c'est la règle des 30 jours qui borne"],
  ];
  for (const [end, limit, lastOk, firstLate, why] of cases) {
    const yearly = sub({ period_start: null, plan: "cortex_pro_yearly", period_end: end });
    const mail = renewalReminderEmail({ renewsAt: end, amount: 119, currency: "EUR", accountUrl: "https://x.test/compte", contact: "c@x.test" });
    assert.ok(mail.text.includes(`DATE LIMITE POUR REFUSER LA RECONDUCTION : ${limit}`), `${end} : encadré « ${limit} »`);
    assert.equal(reminderVerdict(yearly, lastOk), "due", why);
    assert.equal(reminderVerdict(yearly, firstLate), "too-late", why);
  }
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
