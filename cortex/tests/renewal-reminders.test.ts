/**
 * RAPPEL DE RECONDUCTION DE L'ABONNEMENT ANNUEL (art. L215-1 C. conso).
 *  - Un abonnement annuel que Stripe reconduira reçoit UN e-mail, entre 60 jours
 *    et un mois avant l'échéance, qui dit la date, le montant, la reconduction
 *    tacite, comment s'y opposer, et la date limite dans un encadré.
 *  - Un seul par abonnement et par période : ni au passage suivant, ni par une
 *    autre instance ; la période d'après en reçoit un nouveau.
 *  - Résilié, mensuel, trop tôt : rien.
 *  - Refus de Resend ou Stripe injoignable : nouvel essai au passage du
 *    lendemain. Issue inconnue ou process tué en plein envoi : reprise le jour
 *    même, sous la même clé d'idempotence.
 *  - Stripe fait foi pour ce que l'e-mail annonce.
 * Seams : sendRenewalReminders (passage), renewalReminderTick (tâche du jour),
 * renewalReminderEmail, renewalFactsOf. Base Postgres/PGlite en mémoire, Resend
 * simulé sur fetch, état Stripe injecté.
 */
import assert from "node:assert/strict";
import { after, beforeEach, mock, test, type TestContext } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.BILLING_ENABLED = "1";
process.env.RESEND_API_KEY = "re_test";
process.env.STRIPE_SECRET_KEY = "sk_test_jamais_appelee";
process.env.AUTH_URL = "https://app.cortexexam.com";
process.env.LANDING_URL = "https://cortexexam.com";
process.env.CONTACT_EMAIL = "contact@cortexexam.com";
process.env.AUTH_EMAIL_FROM = "Cortex <noreply@cortexexam.com>";
const ENV_KEYS = ["DB_DRIVER", "DATABASE_URL", "BILLING_ENABLED", "RESEND_API_KEY", "STRIPE_SECRET_KEY", "AUTH_URL", "LANDING_URL", "CONTACT_EMAIL", "AUTH_EMAIL_FROM"];
// Sans adresse d'alerte : les e-mails comptés ici sont ceux des clients. L'alerte au propriétaire a son fichier (renewal-alerts.test.ts).
delete process.env.CORTEX_OWNER_EMAIL;
delete process.env.PUBLISHER_EMAIL;

import { authGet, authRun } from "../db/auth-store";
import { grantSubscriptionMonth, setSubscriptionStatus } from "../lib/billing/credits";
import {
  renewalFactsOf, renewalReminderEmail, renewalReminderTick, sendRenewalReminders,
  type ReminderReport, type RenewalFacts,
} from "../lib/billing/renewal-reminders";

const at = (iso: string) => new Date(iso.replace(" ", "T") + "Z");
const START = "2026-10-07 12:00:00";
const END = "2027-10-07 12:00:00";
/** 60 jours avant l'échéance du 7 octobre 2027. */
const J60 = "2027-08-08 12:00:00";

type Mail = { to: string; subject: string; text: string; html: string; key: string | null };
/** Resend simulé : garde les e-mails acceptés ; `respond` décide de la réponse selon le destinataire (défaut : 200). */
function resend(t: TestContext, respond: (to: string) => Response | Promise<Response> = () => new Response("{}", { status: 200 })) {
  const mails: Mail[] = [];
  const attempts: Array<string | null> = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Omit<Mail, "key">;
    const key = (init?.headers as Record<string, string>)["idempotency-key"] ?? null;
    attempts.push(key);
    const res = await respond(body.to);
    if (res.ok) mails.push({ ...body, key });
    return res;
  });
  return { mails, attempts };
}

/** État chez Stripe : par défaut, celui que décrit la base (reconduction prévue, 119 € par an). */
const stripeSays = (over: Partial<RenewalFacts> = {}) => {
  const calls: string[] = [];
  const lookup = async (id: string): Promise<RenewalFacts | null> => {
    calls.push(id);
    return { renews: true, yearly: true, periodEnd: null, amount: 119, currency: "EUR", discounted: false, ...over };
  };
  return { lookup, calls };
};

async function subscriber(user: string, plan: "cortex_pro_yearly" | "cortex_pro_monthly" = "cortex_pro_yearly", start = START, end = END) {
  await authRun(`INSERT INTO users (id, email) VALUES (?,?) ON CONFLICT (id) DO NOTHING`, user, `${user}@exemple.test`);
  await grantSubscriptionMonth({ userId: user, customerId: `cus_${user}`, subscriptionId: `sub_${user}`, plan, periodStart: start, periodEnd: end, at: start });
}
const marker = async (user: string, end = END) =>
  (await authGet<{ value: string }>(`SELECT value FROM app_meta WHERE key = ?`, `renewal_reminder:sub_${user}:${end.replace(" ", "T")}`))?.value;

/** Journal structuré capté (niveau, événement). */
function logs(t: TestContext) {
  const events: Array<{ level: string; evt: string; reason?: string }> = [];
  const keep = (line: unknown) => { try { events.push(JSON.parse(String(line))); } catch { /* ligne libre */ } };
  t.mock.method(console, "error", keep);
  t.mock.method(console, "log", keep);
  return events;
}

beforeEach(async () => {
  await authRun(`DELETE FROM subscriptions`);
  await authRun(`DELETE FROM users`);
  await authRun(`DELETE FROM app_meta WHERE key LIKE 'renewal%'`);
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ENV_KEYS) delete process.env[k];
});

test("annuel à 60 jours de l'échéance : un e-mail dédié, au client, avec tout ce que l'article L215-1 exige", async (t) => {
  const { mails } = resend(t);
  await subscriber("lea");
  const report = await sendRenewalReminders({ now: at(J60), lookup: stripeSays().lookup });
  assert.deepEqual(report, { sent: 1, failed: 0, pending: 0, skipped: 0 });
  assert.equal(mails.length, 1);
  const [mail] = mails;
  assert.equal(mail.to, "lea@exemple.test");
  assert.equal(mail.subject, "Cortex Pro : votre abonnement annuel se renouvelle le 7 octobre 2027");
  assert.match(mail.text, /arrive à échéance le 7 octobre 2027/, "date d'échéance");
  assert.match(mail.text, /119\s€ seront prélevés/, "montant");
  assert.match(mail.text, /reconduction tacite : sans action de votre part, il sera renouvelé automatiquement/, "reconduction tacite");
  assert.match(mail.text, /DATE LIMITE POUR REFUSER LA RECONDUCTION : 6 octobre 2027/, "date limite, dans l'encadré");
  assert.match(mail.text, /vous opposer à ce renouvellement, sans frais/);
  assert.match(mail.text, /https:\/\/app\.cortexexam\.com\/compte/, "où s'y opposer");
  assert.match(mail.text, /« Gérer mon abonnement » \(portail sécurisé Stripe\)/);
  assert.match(mail.text, /prend effet à la fin de la période déjà payée/, "résiliation effective en fin de période");
  assert.match(mail.text, /contact@cortexexam\.com/);
  assert.match(mail.text, /article L215-1 du Code de la consommation/);
  assert.match(mail.text, /https:\/\/cortexexam\.com\/terms/, "lien vers les CGV");
  // Version HTML : la date limite seule dans un cadre visible.
  assert.match(mail.html, /<div style="[^"]*border:2px solid[^"]*">\s*<div[^>]*>Date limite pour refuser la reconduction<\/div>\s*<div[^>]*>6 octobre 2027<\/div>/);
  assert.match(mail.html, /href="https:\/\/app\.cortexexam\.com\/compte"/);
  // Résumé en anglais (la langue du client n'est pas connue de l'app).
  assert.match(mail.text, /renews automatically on 7 October 2027 for €119\. To opt out, cancel by 6 October 2027/);
});

test("un seul e-mail par abonnement et par période, quel que soit le nombre de passages ; la période suivante a le sien", async (t) => {
  const { mails } = resend(t);
  const stripe = stripeSays();
  await subscriber("lea");
  await sendRenewalReminders({ now: at(J60), lookup: stripe.lookup });
  assert.match((await marker("lea")) ?? "", /^sent \d{4}-\d{2}-\d{2}T/, "marqueur persistant, daté");
  for (const later of [J60, "2027-08-09 07:00:00", "2027-09-01 07:00:00", "2027-09-20 07:00:00", "2027-10-07 13:00:00"]) {
    assert.deepEqual(await sendRenewalReminders({ now: at(later), lookup: stripe.lookup }), { sent: 0, failed: 0, pending: 0, skipped: 0 }, later);
  }
  assert.equal(mails.length, 1);
  assert.equal(stripe.calls.length, 1, "un rappel déjà parti ne coûte plus d'appel à Stripe");

  // Reconduit : la facture de l'année suivante ouvre une nouvelle période, donc un nouveau rappel le moment venu.
  await grantSubscriptionMonth({ userId: "lea", subscriptionId: "sub_lea", plan: "cortex_pro_yearly", periodStart: END, periodEnd: "2028-10-07 12:00:00", at: END });
  assert.equal((await sendRenewalReminders({ now: at("2027-11-01 07:00:00"), lookup: stripe.lookup })).sent, 0, "trop tôt pour la nouvelle période");
  assert.equal((await sendRenewalReminders({ now: at("2028-08-09 07:00:00"), lookup: stripe.lookup })).sent, 1);
  assert.equal(mails.length, 2);
  assert.match(mails[1].text, /DATE LIMITE POUR REFUSER LA RECONDUCTION : 6 octobre 2028/);
  assert.notEqual(mails[1].key, mails[0].key);
});

test("deux passages en même temps (deux instances) : un seul e-mail part", async (t) => {
  const { mails } = resend(t);
  await subscriber("lea");
  const stripe = stripeSays();
  const reports = await Promise.all([
    sendRenewalReminders({ now: at(J60), lookup: stripe.lookup }),
    sendRenewalReminders({ now: at(J60), lookup: stripe.lookup }),
  ]);
  assert.equal(mails.length, 1);
  assert.equal(reports[0].sent + reports[1].sent, 1);
});

test("pas d'e-mail : abonnement mensuel, résiliation programmée, abonnement terminé, annuel encore loin de l'échéance", async (t) => {
  const { attempts } = resend(t);
  const stripe = stripeSays();
  await subscriber("mensuel", "cortex_pro_monthly", "2027-08-01 12:00:00", "2027-09-01 12:00:00");
  await subscriber("resilie");
  await setSubscriptionStatus({ subscriptionId: "sub_resilie", status: "active", at: "2027-07-01 10:00:00", cancelAtPeriodEnd: true });
  await subscriber("termine");
  await setSubscriptionStatus({ subscriptionId: "sub_termine", status: "canceled", at: "2027-07-01 10:00:00" });
  await subscriber("recent", "cortex_pro_yearly", "2027-08-01 12:00:00", "2028-08-01 12:00:00");
  for (const now of [J60, "2027-08-20 07:00:00", "2027-08-31 07:00:00"]) {
    assert.deepEqual(await sendRenewalReminders({ now: at(now), lookup: stripe.lookup }), { sent: 0, failed: 0, pending: 0, skipped: 0 }, now);
  }
  assert.equal(attempts.length, 0, "aucun appel à Resend");
  assert.equal(stripe.calls.length, 0, "ni à Stripe : la base suffit à les écarter");
});

test("rattrapage : un annuel déjà dans la fenêtre reçoit son e-mail au premier passage ; hors délai, rien ne part et l'erreur est dite une fois", async (t) => {
  const { mails } = resend(t);
  const events = logs(t);
  const stripe = stripeSays();
  await subscriber("retard");
  assert.equal((await sendRenewalReminders({ now: at("2027-09-05 07:00:00"), lookup: stripe.lookup })).sent, 1, "32 jours avant l'échéance : encore dans les temps");
  assert.equal(mails.length, 1);

  // Un autre abonné, à 20 jours de l'échéance, sans rappel : trop tard pour être conforme.
  await subscriber("oublie");
  for (const now of ["2027-09-17 07:00:00", "2027-09-18 07:00:00"]) {
    assert.deepEqual(await sendRenewalReminders({ now: at(now), lookup: stripe.lookup }), { sent: 0, failed: 0, pending: 0, skipped: 0 });
  }
  assert.equal(mails.length, 1, "aucun e-mail hors délai");
  const missed = events.filter((e) => e.evt === "renewal_reminder.missed");
  assert.equal(missed.length, 1, "signalé une seule fois, et seulement pour celui qui n'a rien reçu");
  assert.equal(missed[0].level, "error");
});

test("dernier jour : le 6 septembre l'e-mail part, le 7 il serait à moins d'un mois de la date limite qu'il annonce", async (t) => {
  const { mails } = resend(t);
  const events = logs(t);
  await subscriber("veille");
  await subscriber("lendemain");
  await authRun(`UPDATE subscriptions SET subscription_id = NULL WHERE user_id = ?`, "lendemain");
  assert.equal((await sendRenewalReminders({ now: at("2027-09-06 07:00:00"), lookup: stripeSays().lookup })).sent, 1);
  assert.match(mails[0].text, /DATE LIMITE POUR REFUSER LA RECONDUCTION : 6 octobre 2027/);
  await authRun(`UPDATE subscriptions SET subscription_id = ? WHERE user_id = ?`, "sub_lendemain", "lendemain");
  assert.deepEqual(await sendRenewalReminders({ now: at("2027-09-07 07:00:00"), lookup: stripeSays().lookup }), { sent: 0, failed: 0, pending: 0, skipped: 0 });
  assert.equal(mails.length, 1, "30 jours et 5 heures avant l'échéance, mais 29 jours avant la date limite : hors délai");
  assert.equal(events.filter((e) => e.evt === "renewal_reminder.missed").length, 1);
});

test("refus de Resend : rien n'est marqué, l'e-mail part au passage du lendemain", async (t) => {
  let up = false;
  const { mails, attempts } = resend(t, () => new Response("{}", { status: up ? 200 : 500 }));
  const events = logs(t);
  const stripe = stripeSays();
  await subscriber("lea");
  assert.deepEqual(await sendRenewalReminders({ now: at(J60), lookup: stripe.lookup }), { sent: 0, failed: 1, pending: 0, skipped: 0 });
  assert.equal(await marker("lea"), undefined, "marqueur rendu : aucun envoi n'est tenu pour fait");
  assert.deepEqual(events.filter((e) => e.evt === "renewal_reminder.not_sent").map((e) => e.level), ["warn"], "panne de Resend (5xx) : passagère");
  up = true;
  assert.deepEqual(await sendRenewalReminders({ now: at("2027-08-09 07:00:00"), lookup: stripe.lookup }), { sent: 1, failed: 0, pending: 0, skipped: 0 });
  assert.equal(mails.length, 1);
  assert.notEqual(attempts[1], attempts[0], "après un refus vu, la clé d'idempotence n'est pas réutilisée");
});

test("refus de Resend sur la configuration (403 : clé, expéditeur) : une erreur, pas un simple avertissement répété un mois", async (t) => {
  resend(t, () => new Response("{}", { status: 403 }));
  const events = logs(t);
  await subscriber("lea");
  assert.deepEqual(await sendRenewalReminders({ now: at(J60), lookup: stripeSays().lookup }), { sent: 0, failed: 1, pending: 0, skipped: 0 });
  assert.deepEqual(events.filter((e) => e.evt === "renewal_reminder.not_sent").map((e) => e.level), ["error"]);
  assert.equal(await marker("lea"), undefined);
});

test("limite de débit de Resend (429) : passagère, un avertissement suffit", async (t) => {
  resend(t, () => new Response("{}", { status: 429 }));
  const events = logs(t);
  await subscriber("lea");
  assert.deepEqual(await sendRenewalReminders({ now: at(J60), lookup: stripeSays().lookup }), { sent: 0, failed: 1, pending: 0, skipped: 0 });
  assert.deepEqual(events.filter((e) => e.evt === "renewal_reminder.not_sent").map((e) => e.level), ["warn"]);
});

test("issue inconnue (Resend ne répond pas) : reprise un quart d'heure plus tard sous la MÊME clé d'idempotence", async (t) => {
  let answer: "silence" | "ok" = "silence";
  const { mails, attempts } = resend(t, () => {
    if (answer === "silence") throw new Error("socket hang up");
    return new Response("{}", { status: 200 });
  });
  const stripe = stripeSays();
  await subscriber("lea");
  mock.timers.enable({ apis: ["Date"], now: at(J60).getTime() });
  try {
    assert.deepEqual(await sendRenewalReminders({ lookup: stripe.lookup }), { sent: 0, failed: 0, pending: 1, skipped: 0 });
    answer = "ok";
    // Tout de suite : la réclamation est peut-être celle d'un envoi en cours ailleurs, on n'y touche pas.
    mock.timers.setTime(at("2027-08-08 12:05:00").getTime());
    assert.deepEqual(await sendRenewalReminders({ lookup: stripe.lookup }), { sent: 0, failed: 0, pending: 1, skipped: 0 });
    assert.equal(attempts.length, 1);
    mock.timers.setTime(at("2027-08-08 12:31:00").getTime());
    assert.deepEqual(await sendRenewalReminders({ lookup: stripe.lookup }), { sent: 1, failed: 0, pending: 0, skipped: 0 });
  } finally {
    mock.timers.reset();
  }
  assert.equal(mails.length, 1);
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0]);
  assert.equal(attempts[1], attempts[0], "même clé : si le premier essai était parti, Resend écarte le second");
});

test("issue inconnue le dernier jour, fenêtre fermée le lendemain : signalé comme jamais confirmé, sans nouvel envoi hors délai", async (t) => {
  const { attempts } = resend(t, () => { throw new Error("socket hang up"); });
  const events = logs(t);
  const stripe = stripeSays();
  await subscriber("lea");
  mock.timers.enable({ apis: ["Date"], now: at("2027-09-06 07:00:00").getTime() });
  try {
    assert.deepEqual(await sendRenewalReminders({ lookup: stripe.lookup }), { sent: 0, failed: 0, pending: 1, skipped: 0 });
    mock.timers.setTime(at("2027-09-07 07:00:00").getTime());
    assert.deepEqual(await sendRenewalReminders({ lookup: stripe.lookup }), { sent: 0, failed: 0, pending: 0, skipped: 0 });
    mock.timers.setTime(at("2027-09-08 07:00:00").getTime());
    await sendRenewalReminders({ lookup: stripe.lookup });
  } finally {
    mock.timers.reset();
  }
  assert.equal(attempts.length, 1, "aucun essai hors délai");
  const missed = events.filter((e) => e.evt === "renewal_reminder.missed") as Array<{ unconfirmed?: boolean }>;
  assert.equal(missed.length, 1);
  assert.equal(missed[0].unconfirmed, true);
  assert.match((await marker("lea")) ?? "", /^missed /);
});

test("Stripe fait foi : pas d'e-mail si la reconduction n'est plus prévue, ni tant qu'il est injoignable", async (t) => {
  const { mails } = resend(t);
  await subscriber("lea");
  // Résiliation faite chez Stripe, événement jamais reçu par l'app.
  assert.deepEqual(await sendRenewalReminders({ now: at(J60), lookup: stripeSays({ renews: false }).lookup }), { sent: 0, failed: 0, pending: 0, skipped: 1 });
  // Vivant en base, inconnu de Stripe (clé d'un autre mode) : une erreur à traiter, pas un silence.
  const events = logs(t);
  assert.deepEqual(await sendRenewalReminders({ now: at(J60), lookup: async () => null }), { sent: 0, failed: 1, pending: 0, skipped: 0 });
  assert.ok(events.some((e) => e.evt === "renewal_reminder.not_sent" && e.level === "error" && /inconnu de Stripe/.test(e.reason ?? "")));
  assert.deepEqual(await sendRenewalReminders({ now: at(J60), lookup: stripeSays({ yearly: false }).lookup }), { sent: 0, failed: 0, pending: 0, skipped: 1 });
  assert.deepEqual(
    await sendRenewalReminders({ now: at(J60), lookup: async () => { throw new Error("ETIMEDOUT"); } }),
    { sent: 0, failed: 1, pending: 0, skipped: 0 },
  );
  assert.deepEqual(await sendRenewalReminders({ now: at(J60), lookup: stripeSays({ amount: null }).lookup }), { sent: 0, failed: 1, pending: 0, skipped: 0 }, "montant illisible : on n'invente pas");
  assert.equal(mails.length, 0);
  assert.equal(await marker("lea"), undefined);
  // Stripe répond de nouveau : le rappel part.
  assert.equal((await sendRenewalReminders({ now: at("2027-08-09 07:00:00"), lookup: stripeSays().lookup })).sent, 1);
});

test("Stripe fait foi : le montant est celui de l'abonnement, la date celle de Stripe", async (t) => {
  const { mails } = resend(t);
  const events = logs(t);
  await subscriber("ancien");
  // Abonné resté à un ancien tarif.
  await sendRenewalReminders({ now: at(J60), lookup: stripeSays({ amount: 99 }).lookup });
  assert.match(mails[0].text, /99\s€ seront prélevés/);
  assert.doesNotMatch(mails[0].text, /119/);

  // Échéance repoussée chez Stripe sans que la base le sache : aucun e-mail avec une date fausse.
  await subscriber("repousse");
  const later = stripeSays({ periodEnd: "2027-12-07 12:00:00" });
  assert.deepEqual(await sendRenewalReminders({ now: at("2027-08-10 07:00:00"), lookup: later.lookup }), { sent: 0, failed: 0, pending: 0, skipped: 1 });
  assert.equal(mails.length, 1);
  await authRun(`DELETE FROM subscriptions WHERE user_id = ?`, "repousse");

  // Échéance avancée chez Stripe : l'e-mail porte la date de Stripe, et ne part qu'une fois.
  await subscriber("avance");
  const sooner = stripeSays({ periodEnd: "2027-10-01 12:00:00" });
  assert.equal((await sendRenewalReminders({ now: at("2027-08-10 07:00:00"), lookup: sooner.lookup })).sent, 1);
  assert.match(mails[1].text, /arrive à échéance le 1 octobre 2027/);
  assert.match(mails[1].text, /DATE LIMITE POUR REFUSER LA RECONDUCTION : 30 septembre 2027/);
  assert.deepEqual(await sendRenewalReminders({ now: at("2027-08-11 07:00:00"), lookup: sooner.lookup }), { sent: 0, failed: 0, pending: 0, skipped: 0 });
  assert.equal(mails.length, 2);

  // Passé le délai compté sur la date de la BASE : pas de fausse alerte, ni pour celui
  // qui a reçu son e-mail sous la date de Stripe, ni pour celui que Stripe ne reconduira pas.
  await subscriber("parti");
  const late = at("2027-09-20 07:00:00");
  assert.deepEqual(await sendRenewalReminders({ now: late, lookup: async (id) => (await (id === "sub_parti" ? stripeSays({ renews: false }) : sooner).lookup(id)) }), { sent: 0, failed: 0, pending: 0, skipped: 1 });
  assert.equal(events.filter((e) => e.evt === "renewal_reminder.missed").length, 0);
  assert.equal(mails.length, 2);
});

test("remise lue chez Stripe : l'e-mail envoyé annonce le montant « au plus »", async (t) => {
  const { mails } = resend(t);
  await subscriber("remise");
  assert.equal((await sendRenewalReminders({ now: at(J60), lookup: stripeSays({ discounted: true }).lookup })).sent, 1);
  assert.match(mails[0].text, /119\s€ au plus seront prélevés/);
});

test("remise posée sur l'abonnement : le montant annoncé est un maximum, pas une promesse", () => {
  const mail = renewalReminderEmail({ renewsAt: END, amount: 119, currency: "EUR", discounted: true, accountUrl: "https://app.cortexexam.com/compte", contact: "contact@cortexexam.com" });
  assert.match(mail.text, /119\s€ au plus seront prélevés sur votre moyen de paiement \(une remise s'applique à votre abonnement : le montant exact figurera sur votre facture\)/);
  assert.match(mail.text, /for up to €119 \(a discount applies\)/);
  assert.match(mail.html, /119\s€ au plus seront prélevés/);
});

test("compte sans adresse e-mail : rien ne part, c'est une erreur à traiter", async (t) => {
  const { attempts } = resend(t);
  const events = logs(t);
  await subscriber("lea");
  await authRun(`UPDATE users SET email = NULL WHERE id = ?`, "lea");
  assert.deepEqual(await sendRenewalReminders({ now: at(J60), lookup: stripeSays().lookup }), { sent: 0, failed: 1, pending: 0, skipped: 0 });
  assert.equal(attempts.length, 0);
  assert.ok(events.some((e) => e.evt === "renewal_reminder.not_sent" && e.level === "error"));
});

test("e-mail : les dates sont celles que lit le client (heure de Paris), la limite est la veille de l'échéance", () => {
  // 22 h 30 UTC le 7 octobre = 0 h 30 le 8 à Paris.
  const mail = renewalReminderEmail({ renewsAt: "2027-10-07 22:30:00", amount: 119, currency: "EUR", accountUrl: "https://app.cortexexam.com/compte", contact: "contact@cortexexam.com" });
  assert.match(mail.text, /arrive à échéance le 8 octobre 2027/);
  assert.match(mail.text, /DATE LIMITE POUR REFUSER LA RECONDUCTION : 7 octobre 2027/);
  assert.match(mail.text, /jusqu'au 7 octobre 2027 inclus/);
  // Échéance un 1er du mois : la limite est le dernier jour du mois précédent.
  const first = renewalReminderEmail({ renewsAt: "2028-03-01 10:00:00", amount: 14.9, currency: "EUR", accountUrl: "https://x.test/compte", contact: "c@x.test" });
  assert.match(first.text, /DATE LIMITE POUR REFUSER LA RECONDUCTION : 29 février 2028/);
  assert.match(first.text, /14,90\s€/);
  // Rien d'interprétable ne passe dans le HTML.
  const odd = renewalReminderEmail({ renewsAt: END, amount: 119, currency: "EUR", accountUrl: "https://x.test/compte?a=1&b=<2>", contact: "c@x.test" });
  assert.doesNotMatch(odd.html, /<2>/);
});

test("lecture d'un abonnement Stripe : période sur l'item (format récent) ou sur l'abonnement (ancien), résiliation programmée", () => {
  const unix = (iso: string) => Math.floor(at(iso).getTime() / 1000);
  const price = { unit_amount: 11900, currency: "eur", recurring: { interval: "year" } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const facts = (sub: unknown) => renewalFactsOf(sub as any);
  assert.deepEqual(
    facts({ status: "active", cancel_at_period_end: false, cancel_at: null, items: { data: [{ quantity: 1, price, current_period_end: unix(END) }] } }),
    { renews: true, yearly: true, periodEnd: END, amount: 119, currency: "EUR", discounted: false },
  );
  assert.equal(facts({ status: "active", discounts: ["di_1"], items: { data: [{ price }] } }).discounted, true, "remise (format récent)");
  assert.equal(facts({ status: "active", discount: { id: "di_1" }, items: { data: [{ price }] } }).discounted, true, "remise (ancien format)");
  assert.equal(facts({ status: "active", discounts: [], items: { data: [{ price }] } }).discounted, false);
  assert.equal(facts({ status: "active", current_period_end: unix(END), items: { data: [{ price }] } }).periodEnd, END, "ancien format");
  assert.equal(facts({ status: "active", cancel_at_period_end: true, items: { data: [{ price }] } }).renews, false);
  assert.equal(facts({ status: "active", cancel_at: unix(END), items: { data: [{ price }] } }).renews, false, "résiliation à date");
  assert.equal(facts({ status: "canceled", items: { data: [{ price }] } }).renews, false);
  assert.equal(facts({ status: "past_due", items: { data: [{ price }] } }).renews, true, "impayé : Stripe relance, l'abonnement court toujours");
  const monthly = facts({ status: "active", items: { data: [{ price: { unit_amount: 1490, currency: "eur", recurring: { interval: "month" } } }] } });
  assert.deepEqual([monthly.yearly, monthly.amount], [false, 14.9]);
  assert.equal(facts({ status: "active", items: { data: [{ price: { unit_amount: null, currency: "eur", recurring: { interval: "year" } } }] } }).amount, null);
});

// ─────────────────────────── tâche quotidienne ───────────────────────────

const quiet: ReminderReport = { sent: 0, failed: 0, pending: 0, skipped: 0 };

test("tâche du jour : un seul passage par jour UTC, même avec deux instances ; le lendemain, un nouveau", async () => {
  let runs = 0;
  const run = async () => { runs++; return quiet; };
  const morning = at("2027-08-08 07:10:00");
  const both = await Promise.all([renewalReminderTick({ now: morning, run }), renewalReminderTick({ now: morning, run })]);
  assert.deepEqual([...both].sort(), ["ok", "skipped:done"]);
  assert.equal(await renewalReminderTick({ now: at("2027-08-08 07:40:00"), run }), "skipped:done");
  assert.equal(await renewalReminderTick({ now: at("2027-08-08 23:40:00"), run }), "skipped:done");
  assert.equal(runs, 1);
  assert.equal(await renewalReminderTick({ now: at("2027-08-09 06:59:00"), run }), "skipped:too-early", "pas avant 7 h UTC");
  assert.equal(await renewalReminderTick({ now: at("2027-08-09 07:00:00"), run }), "ok");
  assert.equal(runs, 2);
});

test("tâche du jour : un refus attend demain, une panne du passage se reprend au tick suivant", async () => {
  const reports: Array<ReminderReport | Error> = [{ ...quiet, failed: 1 }, new Error("base injoignable"), quiet];
  let runs = 0;
  const run = async () => { const r = reports[runs++]; if (r instanceof Error) throw r; return r; };
  assert.equal(await renewalReminderTick({ now: at("2027-08-08 07:00:00"), run }), "ok");
  assert.equal(await renewalReminderTick({ now: at("2027-08-08 07:30:00"), run }), "skipped:done", "refus net : pas de nouvel essai le jour même");
  assert.equal(await renewalReminderTick({ now: at("2027-08-09 07:00:00"), run }), "failed");
  assert.equal(await renewalReminderTick({ now: at("2027-08-09 07:30:00"), run }), "ok");
  assert.equal(await renewalReminderTick({ now: at("2027-08-09 08:00:00"), run }), "skipped:done");
  assert.equal(runs, 3);
});

test("tâche du jour : une issue inconnue est reprise au tick suivant, le jour même, sous la même clé", async (t) => {
  let answer: "silence" | "ok" = "silence";
  const { mails, attempts } = resend(t, () => {
    if (answer === "silence") throw new Error("socket hang up");
    return new Response("{}", { status: 200 });
  });
  const stripe = stripeSays();
  const run = (now: Date, only?: ReadonlySet<string>) => sendRenewalReminders({ now, lookup: stripe.lookup, only });
  await subscriber("lea");
  mock.timers.enable({ apis: ["Date"], now: at("2027-08-09 07:00:10").getTime() });
  try {
    assert.equal(await renewalReminderTick({ run }), "retry");
    answer = "ok";
    mock.timers.setTime(at("2027-08-09 07:10:00").getTime());
    assert.equal(await renewalReminderTick({ run }), "retry", "réclamation trop récente pour être celle d'un process mort : on attend");
    assert.equal(attempts.length, 1);
    mock.timers.setTime(at("2027-08-09 07:40:00").getTime());
    assert.equal(await renewalReminderTick({ run }), "ok");
    mock.timers.setTime(at("2027-08-09 08:10:00").getTime());
    assert.equal(await renewalReminderTick({ run }), "skipped:done");
  } finally {
    mock.timers.reset();
  }
  assert.equal(mails.length, 1);
  assert.equal(attempts[1], attempts[0]);
});

test("tâche du jour : process tué entre l'envoi et son marquage, la réclamation laissée est reprise le jour même, pas le lendemain", async (t) => {
  const { mails } = resend(t);
  const stripe = stripeSays();
  const run = (now: Date, only?: ReadonlySet<string>) => sendRenewalReminders({ now, lookup: stripe.lookup, only });
  await subscriber("zoe");
  mock.timers.enable({ apis: ["Date"], now: at("2027-08-09 07:00:10").getTime() });
  try {
    // Ce que laisse un process mort en plein envoi : le jour réclamé, et une réclamation jamais conclue.
    assert.equal(await renewalReminderTick({ run: async () => quiet }), "ok");
    await authRun(`INSERT INTO app_meta (key, value) VALUES (?, ?)`, "renewal_reminder:sub_zoe:2027-10-07T12:00:00", `${new Date().toISOString()} chaine-zoe essai-1`);
    mock.timers.setTime(at("2027-08-09 07:40:00").getTime());
    assert.equal(await renewalReminderTick({ run }), "ok", "le jour est fait, mais une réclamation attend : nouveau passage");
    assert.equal(mails.length, 1);
    assert.equal(mails[0].key, "renewal_reminder:sub_zoe:2027-10-07T12:00:00:chaine-zoe", "même clé que l'essai interrompu : Resend écarte le doublon s'il était parti");
    assert.match((await marker("zoe")) ?? "", /^sent /);
    mock.timers.setTime(at("2027-08-09 08:10:00").getTime());
    assert.equal(await renewalReminderTick({ run }), "skipped:done");
  } finally {
    mock.timers.reset();
  }
  assert.equal(mails.length, 1);
});

test("tâche du jour : une réclamation orpheline ne relance ni un passage complet à chaque tick, ni les essais des autres abonnés", async (t) => {
  const { attempts } = resend(t, (to) => {
    if (to === "refuse@exemple.test") return new Response("{}", { status: 403 });
    throw new Error("socket hang up");
  });
  logs(t);
  const stripe = stripeSays();
  const run = (now: Date, only?: ReadonlySet<string>) => sendRenewalReminders({ now, lookup: stripe.lookup, only });
  await subscriber("parti");
  await subscriber("refuse");
  mock.timers.enable({ apis: ["Date"], now: at("2027-08-09 07:00:10").getTime() });
  try {
    assert.equal(await renewalReminderTick({ run }), "retry", "parti : issue inconnue ; refuse : refus net");
    assert.deepEqual([attempts.length, stripe.calls.length], [2, 2]);
    // « parti » résilie dans le portail : sa ligne n'est plus candidate, sa réclamation reste.
    await setSubscriptionStatus({ subscriptionId: "sub_parti", status: "active", at: "2027-08-09 07:05:00", cancelAtPeriodEnd: true });
    for (const later of ["2027-08-09 07:40:00", "2027-08-09 08:10:00", "2027-08-09 15:10:00", "2027-08-09 23:40:00"]) {
      mock.timers.setTime(at(later).getTime());
      assert.equal(await renewalReminderTick({ run }), "ok", later);
    }
    assert.deepEqual([attempts.length, stripe.calls.length], [2, 2], "le refus de « refuse » attend bien demain : ni Resend ni Stripe rappelés");
    // Le lendemain : le passage du jour (un essai pour « refuse »), puis plus rien, la réclamation a plus de 24 h.
    mock.timers.setTime(at("2027-08-10 07:00:10").getTime());
    assert.equal(await renewalReminderTick({ run }), "ok");
    assert.equal(attempts.length, 3);
    for (const later of ["2027-08-10 07:40:00", "2027-08-10 08:10:00"]) {
      mock.timers.setTime(at(later).getTime());
      assert.equal(await renewalReminderTick({ run }), "skipped:done", later);
    }
    assert.equal(attempts.length, 3);
  } finally {
    mock.timers.reset();
  }
});

test("tâche du jour : inactive sans facturation, et sans de quoi envoyer", async () => {
  let runs = 0;
  const run = async () => { runs++; return quiet; };
  const now = at("2027-08-11 08:00:00");
  const env = { BILLING_ENABLED: "1", RESEND_API_KEY: "re_x", AUTH_EMAIL_FROM: "Cortex <noreply@cortexexam.com>", STRIPE_SECRET_KEY: "sk_x", AUTH_URL: "https://app.cortexexam.com" };
  assert.equal(await renewalReminderTick({ now, run, env: { ...env, BILLING_ENABLED: undefined } }), "skipped:billing-off");
  for (const missing of ["RESEND_API_KEY", "AUTH_EMAIL_FROM", "STRIPE_SECRET_KEY", "AUTH_URL"]) {
    assert.equal(await renewalReminderTick({ now, run, env: { ...env, [missing]: undefined } }), "skipped:not-configured", missing);
  }
  assert.equal(runs, 0);
  // Sans `run` injecté, la tâche fait le vrai passage (ici : aucun abonné, donc aucun appel externe).
  assert.equal(await renewalReminderTick({ now, env }), "ok");
});
