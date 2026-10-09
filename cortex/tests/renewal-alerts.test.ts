/**
 * ALERTE AU PROPRIÉTAIRE QUAND LE RAPPEL DE RECONDUCTION ÉCHOUE. Sans suivi
 * d'erreurs, un rappel manqué ne se voyait que dans les logs Railway, alors
 * qu'il donne à l'abonné le droit de résilier sans frais après la reconduction.
 *  - Refus persistant, rappel hors délai, rappels désactivés : UN e-mail à
 *    l'adresse d'alerte, qui nomme l'abonné, la date de reconduction et quoi faire.
 *  - Au plus un par type d'erreur et par jour, quel que soit le nombre de
 *    passages ou d'instances ; plusieurs abonnés le même jour : un seul e-mail.
 *  - Resend indisponible : le passage du rappel se termine comme si de rien
 *    n'était ; un rappel hors délai, constaté une seule fois, reste à signaler
 *    et part au passage suivant.
 * Seams : sendRenewalReminders (passage), startRenewalReminderScheduler
 * (démarrage) et l'alerte qu'il lance sans l'attendre, alertRemindersDisabled.
 * Base Postgres/PGlite en mémoire, Resend simulé sur fetch, état Stripe injecté.
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
process.env.CORTEX_OWNER_EMAIL = "ben@exemple.test";
delete process.env.PUBLISHER_EMAIL;
const ENV_KEYS = ["DB_DRIVER", "DATABASE_URL", "BILLING_ENABLED", "RESEND_API_KEY", "STRIPE_SECRET_KEY", "AUTH_URL", "LANDING_URL", "CONTACT_EMAIL", "AUTH_EMAIL_FROM", "CORTEX_OWNER_EMAIL", "PUBLISHER_EMAIL"];

import { authRun } from "../db/auth-store";
import { grantSubscriptionMonth } from "../lib/billing/credits";
import { alertRemindersDisabled } from "../lib/billing/renewal-alerts";
import { sendRenewalReminders, startRenewalReminderScheduler, type RenewalFacts } from "../lib/billing/renewal-reminders";

const OWNER = "ben@exemple.test";
const at = (iso: string) => new Date(iso.replace(" ", "T") + "Z");
const START = "2026-10-07 12:00:00";
const END = "2027-10-07 12:00:00";
/** 60 jours avant l'échéance du 7 octobre 2027. */
const J60 = "2027-08-08 12:00:00";

type Mail = { to: string; subject: string; text: string };
/** Resend simulé : garde les e-mails acceptés ; `respond` décide de la réponse selon le destinataire (défaut : 200). */
function resend(t: TestContext, respond: (to: string) => Response | Promise<Response> = () => new Response("{}", { status: 200 })) {
  const mails: Mail[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Mail;
    const res = await respond(body.to);
    if (res.ok) mails.push(body);
    return res;
  });
  return { mails, toOwner: () => mails.filter((m) => m.to === OWNER) };
}

/** Stripe confirme ce que dit la base : reconduction prévue, 119 € par an. */
const stripe = async (): Promise<RenewalFacts | null> => ({ renews: true, yearly: true, periodEnd: null, amount: 119, currency: "EUR", discounted: false });

async function subscriber(user: string, end = END) {
  await authRun(`INSERT INTO users (id, email) VALUES (?,?) ON CONFLICT (id) DO NOTHING`, user, `${user}@exemple.test`);
  await grantSubscriptionMonth({ userId: user, customerId: `cus_${user}`, subscriptionId: `sub_${user}`, plan: "cortex_pro_yearly", periodStart: START, periodEnd: end, at: START });
}

/** Journal structuré capté (et tenu hors de la sortie des tests). */
function logs(t: TestContext) {
  const events: Array<{ level: string; evt: string; reason?: string }> = [];
  const keep = (line: unknown) => { try { events.push(JSON.parse(String(line))); } catch { /* ligne libre */ } };
  t.mock.method(console, "error", keep);
  t.mock.method(console, "log", keep);
  return events;
}

/** Attend qu'une tâche lancée sans être attendue (l'alerte du démarrage) ait abouti. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(done(), "toujours rien après 2 s");
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

test("refus persistant (compte sans adresse) : un e-mail au propriétaire, avec l'abonné, la date de reconduction, la cause et quoi faire", async (t) => {
  const { mails } = resend(t);
  logs(t);
  await subscriber("lea");
  await authRun(`UPDATE users SET email = NULL WHERE id = ?`, "lea");
  await sendRenewalReminders({ now: at(J60), lookup: stripe });
  assert.equal(mails.length, 1, "le client n'a pas d'adresse : seul le propriétaire est écrit");
  const [mail] = mails;
  assert.equal(mail.to, OWNER);
  assert.equal(mail.subject, "Cortex : rappel de reconduction en échec (1 abonné)");
  assert.match(mail.text, /abonnement sub_lea/, "abonnement");
  assert.match(mail.text, /compte lea/, "identifiant interne du compte");
  assert.match(mail.text, /reconduction le 7 octobre 2027/, "date de reconduction");
  assert.match(mail.text, /compte sans adresse e-mail/, "cause");
  assert.match(mail.text, /À faire/, "quoi faire");
});

test("au plus un e-mail par type d'erreur et par jour : ni au passage suivant, ni par une autre instance ; le lendemain, si la cause dure, un nouveau", async (t) => {
  const { toOwner } = resend(t);
  logs(t);
  await subscriber("lea");
  await authRun(`UPDATE users SET email = NULL WHERE id = ?`, "lea");
  // Deux instances font le même passage en même temps, puis un passage de reprise le même jour.
  await Promise.all([sendRenewalReminders({ now: at(J60), lookup: stripe }), sendRenewalReminders({ now: at(J60), lookup: stripe })]);
  await sendRenewalReminders({ now: at("2027-08-08 19:30:00"), lookup: stripe });
  assert.equal(toOwner().length, 1);
  await sendRenewalReminders({ now: at("2027-08-09 07:00:00"), lookup: stripe });
  assert.equal(toOwner().length, 2, "la cause dure : rappelé le lendemain");
  await sendRenewalReminders({ now: at("2027-08-09 07:30:00"), lookup: stripe });
  assert.equal(toOwner().length, 2);
});

test("plusieurs abonnés en échec au même passage : un seul e-mail qui les nomme tous ; une panne passagère n'alerte pas", async (t) => {
  const { toOwner } = resend(t, (to) => new Response("{}", { status: to === "refuse@exemple.test" ? 403 : 200 }));
  logs(t);
  await subscriber("refuse");
  await subscriber("inconnu", "2027-10-01 12:00:00");
  await subscriber("panne");
  const lookup = async (id: string) => {
    if (id === "sub_inconnu") return null; // la clé en place ne connaît pas cet abonnement
    if (id === "sub_panne") throw new Error("ETIMEDOUT"); // Stripe injoignable : réessayer demain suffira
    return stripe();
  };
  await sendRenewalReminders({ now: at(J60), lookup });
  assert.equal(toOwner().length, 1);
  const [mail] = toOwner();
  assert.equal(mail.subject, "Cortex : rappel de reconduction en échec (2 abonnés)");
  assert.match(mail.text, /refuse@exemple\.test \(compte refuse, abonnement sub_refuse\) : reconduction le 7 octobre 2027\. Cause : Resend a répondu HTTP 403\./);
  assert.match(mail.text, /inconnu@exemple\.test \(compte inconnu, abonnement sub_inconnu\) : reconduction le 1 octobre 2027\. Cause : abonnement inconnu de Stripe/);
  assert.doesNotMatch(mail.text, /sub_panne/);
});

test("rappel hors délai : un e-mail au propriétaire, avec l'abonné, la date de reconduction, la conséquence et quoi faire ; dit une seule fois", async (t) => {
  const { mails, toOwner } = resend(t);
  logs(t);
  await subscriber("oublie");
  // 20 jours avant l'échéance, aucun rappel parti : trop tard pour être conforme.
  await sendRenewalReminders({ now: at("2027-09-17 07:00:00"), lookup: stripe });
  assert.equal(mails.length, 1, "rien n'est envoyé au client hors délai");
  const [mail] = toOwner();
  assert.equal(mail.subject, "Cortex : rappel de reconduction hors délai (1 abonné)");
  assert.match(mail.text, /oublie@exemple\.test \(compte oublie, abonnement sub_oublie\) : reconduction le 7 octobre 2027\. Aucun e-mail n'est parti\./);
  assert.match(mail.text, /résilier sans frais/, "conséquence");
  assert.match(mail.text, /À faire :\n1\. Tu peux prévenir l'abonné toi-même/, "quoi faire");
  assert.doesNotMatch(mail.text, /journal de Resend/, "aucun essai n'est resté sans réponse : rien à y chercher");
  for (const later of ["2027-09-17 07:30:00", "2027-09-18 07:00:00", "2027-09-19 07:00:00"]) await sendRenewalReminders({ now: at(later), lookup: stripe });
  assert.equal(toOwner().length, 1, "constaté une fois, signalé une fois");
});

test("rappel hors délai après un essai resté sans réponse : l'e-mail dit que le rappel est peut-être parti, et où le vérifier", async (t) => {
  const { toOwner } = resend(t, (to) => {
    if (to !== OWNER) throw new Error("socket hang up");
    return new Response("{}", { status: 200 });
  });
  logs(t);
  await subscriber("lea");
  mock.timers.enable({ apis: ["Date"], now: at("2027-09-06 07:00:00").getTime() });
  try {
    await sendRenewalReminders({ lookup: stripe }); // dernier jour de la fenêtre : Resend ne répond pas
    mock.timers.setTime(at("2027-09-07 07:00:00").getTime());
    await sendRenewalReminders({ lookup: stripe }); // fenêtre fermée
  } finally {
    mock.timers.reset();
  }
  assert.equal(toOwner().length, 1);
  assert.match(toOwner()[0].text, /abonnement sub_lea\) : reconduction le 7 octobre 2027\. Un essai est resté sans réponse de Resend : l'e-mail est peut-être parti à temps\./);
  assert.match(toOwner()[0].text, /À faire :\n1\. Cherche l'adresse de l'abonné dans le journal de Resend/);
});

test("Resend indisponible : le passage du rappel se termine comme d'habitude ; le rappel hors délai reste à signaler et part au passage suivant, une seule fois", async (t) => {
  let up = false;
  const { toOwner } = resend(t, () => {
    if (!up) throw new Error("socket hang up");
    return new Response("{}", { status: 200 });
  });
  logs(t);
  await subscriber("oublie"); // à 20 jours de l'échéance : hors délai
  await subscriber("muet", "2027-11-10 12:00:00"); // dans la fenêtre, mais sans adresse : refus persistant
  await authRun(`UPDATE users SET email = NULL WHERE id = ?`, "muet");
  const expected = { sent: 0, failed: 1, pending: 0, skipped: 0 };

  assert.deepEqual(await sendRenewalReminders({ now: at("2027-09-17 07:00:00"), lookup: stripe }), expected, "même compte rendu qu'avec Resend en marche");
  assert.equal(toOwner().length, 0);

  up = true;
  assert.deepEqual(await sendRenewalReminders({ now: at("2027-09-18 07:00:00"), lookup: stripe }), expected);
  const late = toOwner().filter((m) => m.subject.includes("hors délai"));
  assert.equal(late.length, 1, "le constat de la veille n'est pas perdu");
  assert.match(late[0].text, /abonnement sub_oublie/);
  assert.equal(toOwner().filter((m) => m.subject.includes("en échec")).length, 1, "le refus qui dure est signalé aussi");

  await sendRenewalReminders({ now: at("2027-09-19 07:00:00"), lookup: stripe });
  assert.equal(toOwner().filter((m) => m.subject.includes("hors délai")).length, 1, "une fois parti, plus jamais");
});

test("refus net de Resend pour l'alerte (5xx) : rien n'est tenu pour envoyé, elle repart au passage suivant du même jour", async (t) => {
  let up = false;
  const { toOwner } = resend(t, () => new Response("{}", { status: up ? 200 : 503 }));
  logs(t);
  await subscriber("oublie");
  await sendRenewalReminders({ now: at("2027-09-17 07:00:00"), lookup: stripe });
  assert.equal(toOwner().length, 0);
  up = true;
  await sendRenewalReminders({ now: at("2027-09-17 07:30:00"), lookup: stripe });
  await sendRenewalReminders({ now: at("2027-09-17 08:00:00"), lookup: stripe });
  assert.deepEqual(toOwner().map((m) => m.subject), ["Cortex : rappel de reconduction hors délai (1 abonné)"]);
});

test("aucune adresse d'alerte configurée : rien n'est envoyé, le journal le dit, et le constat part dès qu'une adresse est posée", async (t) => {
  const { mails, toOwner } = resend(t);
  const events = logs(t);
  await subscriber("oublie");
  delete process.env.CORTEX_OWNER_EMAIL;
  try {
    assert.deepEqual(await sendRenewalReminders({ now: at("2027-09-17 07:00:00"), lookup: stripe }), { sent: 0, failed: 0, pending: 0, skipped: 0 });
  } finally {
    process.env.CORTEX_OWNER_EMAIL = OWNER;
  }
  assert.equal(mails.length, 0);
  assert.ok(events.some((e) => e.evt === "renewal_alert.not_sent" && e.level === "warn" && /CORTEX_OWNER_EMAIL ou PUBLISHER_EMAIL/.test(e.reason ?? "")), JSON.stringify(events));
  await sendRenewalReminders({ now: at("2027-09-18 07:00:00"), lookup: stripe });
  assert.equal(toOwner().length, 1);
});

test("envoi d'alerte resté sans réponse, puis un second rappel hors délai le même jour : la reprise n'est pas prise pour un doublon, le second abonné est signalé", async (t) => {
  // Resend tel qu'il se comporte : il accepte le premier essai mais sa réponse se perd ; sous la même
  // clé d'idempotence, un contenu identique n'est pas renvoyé, un contenu différent est refusé (409).
  const accepted = new Map<string, string>();
  const delivered: Mail[] = [];
  let silent = true;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Mail;
    const key = (init?.headers as Record<string, string>)["idempotency-key"];
    const first = accepted.get(key);
    if (first !== undefined && first !== body.text) return new Response(JSON.stringify({ name: "invalid_idempotent_request" }), { status: 409 });
    if (first === undefined) { accepted.set(key, body.text); delivered.push(body); }
    if (silent) throw new Error("socket hang up");
    return new Response("{}", { status: 200 });
  });
  logs(t);
  await subscriber("premier");
  mock.timers.enable({ apis: ["Date"], now: at("2027-09-17 07:00:00").getTime() });
  try {
    await sendRenewalReminders({ lookup: stripe });
    silent = false;
    await subscriber("second");
    mock.timers.setTime(at("2027-09-17 07:30:00").getTime());
    await sendRenewalReminders({ lookup: stripe });
    mock.timers.setTime(at("2027-09-18 07:00:00").getTime());
    await sendRenewalReminders({ lookup: stripe });
  } finally {
    mock.timers.reset();
  }
  assert.ok(delivered.some((m) => /abonnement sub_second/.test(m.text)), "le second abonné figure dans un e-mail réellement parti");
});

test("rappels désactivés au démarrage (variable manquante) : un e-mail au propriétaire, qui nomme la variable et dit quoi faire", async (t) => {
  const { toOwner } = resend(t);
  logs(t);
  delete process.env.STRIPE_SECRET_KEY;
  try {
    assert.equal(startRenewalReminderScheduler(), null);
    await until(() => toOwner().length === 1);
    // Chaque redéploiement redémarre le serveur : un seul e-mail par jour.
    await alertRemindersDisabled("STRIPE_SECRET_KEY absente");
    await alertRemindersDisabled("STRIPE_SECRET_KEY absente");
  } finally {
    process.env.STRIPE_SECRET_KEY = "sk_test_jamais_appelee";
  }
  assert.equal(toOwner().length, 1);
  const [mail] = toOwner();
  assert.equal(mail.subject, "Cortex : rappels de reconduction désactivés");
  assert.match(mail.text, /STRIPE_SECRET_KEY absente/, "la variable qui manque");
  assert.match(mail.text, /aucun rappel ne part/, "conséquence");
  assert.match(mail.text, /À faire/, "quoi faire");
});

test("démarrage sans adresse d'alerte : le journal prévient que les échecs du rappel ne seront signalés à personne", async (t) => {
  const { mails } = resend(t);
  const events = logs(t);
  delete process.env.CORTEX_OWNER_EMAIL;
  let timer: NodeJS.Timeout | null = null;
  try {
    timer = startRenewalReminderScheduler();
  } finally {
    process.env.CORTEX_OWNER_EMAIL = OWNER;
    if (timer) clearInterval(timer);
  }
  assert.ok(timer, "les rappels eux-mêmes restent actifs");
  assert.ok(events.some((e) => e.evt === "renewal_alert.disabled" && e.level === "warn" && /CORTEX_OWNER_EMAIL ou PUBLISHER_EMAIL/.test(e.reason ?? "")), JSON.stringify(events));
  assert.equal(mails.length, 0);
});

test("une panne de l'alerte elle-même (sa table en défaut) ne fait jamais échouer le passage du rappel", async (t) => {
  resend(t);
  const events = logs(t);
  await authRun(`ALTER TABLE app_meta RENAME TO app_meta_en_panne`);
  try {
    assert.deepEqual(await sendRenewalReminders({ now: at(J60), lookup: stripe }), { sent: 0, failed: 0, pending: 0, skipped: 0 });
  } finally {
    await authRun(`ALTER TABLE app_meta_en_panne RENAME TO app_meta`);
  }
  assert.ok(events.some((e) => e.evt === "renewal_alert.not_sent" && e.level === "warn"), JSON.stringify(events));
});
