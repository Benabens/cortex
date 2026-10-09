/**
 * Rappel de reconduction sur SQLite (le store du dev local) : le passage du
 * jour, la réclamation par abonnement, le signalement hors délai et l'alerte
 * au propriétaire y passent par les mêmes requêtes qu'en Postgres, et doivent
 * y tenir aussi. Le détail des comportements est couvert sur PGlite
 * (renewal-reminders.test.ts, renewal-alerts.test.ts).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-rappel-sqlite-"));
process.env.CORTEX_DATA_DIR = tmp;
const ENV: Record<string, string> = {
  BILLING_ENABLED: "1", RESEND_API_KEY: "re_test", AUTH_EMAIL_FROM: "Cortex <noreply@cortexexam.com>",
  STRIPE_SECRET_KEY: "sk_test_jamais_appelee", AUTH_URL: "https://app.cortexexam.com",
};

before(() => {
  for (const k of ["DB_DRIVER", "DATABASE_URL", "CORTEX_OWNER_EMAIL", "PUBLISHER_EMAIL"]) delete process.env[k];
  Object.assign(process.env, ENV);
});
after(() => {
  for (const k of [...Object.keys(ENV), "CORTEX_DATA_DIR", "CORTEX_OWNER_EMAIL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const at = (iso: string) => new Date(iso.replace(" ", "T") + "Z");

test("sqlite : un passage par jour, un e-mail par abonnement et par période, hors délai signalé une fois", async (t) => {
  const { authGet, authRun } = await import("../db/auth-store");
  const { grantSubscriptionMonth } = await import("../lib/billing/credits");
  const { renewalReminderTick, sendRenewalReminders } = await import("../lib/billing/renewal-reminders");
  const recipients: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    recipients.push((JSON.parse(String(init?.body)) as { to: string }).to);
    return new Response("{}", { status: 200 });
  });
  const errors: string[] = [];
  t.mock.method(console, "error", (line: unknown) => { errors.push(String(line)); });
  const subscriber = async (user: string, end: string) => {
    await authRun(`INSERT INTO users (id, email) VALUES (?,?)`, user, `${user}@exemple.test`);
    await grantSubscriptionMonth({ userId: user, customerId: `cus_${user}`, subscriptionId: `sub_${user}`, plan: "cortex_pro_yearly", periodStart: "2026-10-07 12:00:00", periodEnd: end, at: "2026-10-07 12:00:00" });
  };
  await subscriber("lea", "2027-10-07 12:00:00");
  await subscriber("oublie", "2027-08-29 12:00:00"); // à 20 jours de l'échéance, sans rappel
  const lookup = async () => ({ renews: true, yearly: true, periodEnd: null, amount: 119, currency: "EUR", discounted: false });
  const run = (now: Date) => sendRenewalReminders({ now, lookup });

  assert.equal(await renewalReminderTick({ now: at("2027-08-09 07:00:00"), run }), "ok");
  assert.deepEqual(recipients, ["lea@exemple.test"]);
  const marker = await authGet<{ value: string }>(`SELECT value FROM app_meta WHERE key = ?`, "renewal_reminder:sub_lea:2027-10-07T12:00:00");
  assert.match(marker?.value ?? "", /^sent \d{4}-/);
  assert.equal(await renewalReminderTick({ now: at("2027-08-09 07:30:00"), run }), "skipped:done");
  assert.equal(await renewalReminderTick({ now: at("2027-08-10 07:00:00"), run }), "ok");
  assert.equal(recipients.length, 1, "ni au tick suivant, ni le lendemain");
  assert.equal(errors.filter((line) => line.includes("renewal_reminder.missed")).length, 1);
});

test("sqlite : rappel hors délai et refus persistant signalés au propriétaire, une fois par type et par jour", async (t) => {
  const { authRun } = await import("../db/auth-store");
  const { grantSubscriptionMonth } = await import("../lib/billing/credits");
  const { sendRenewalReminders } = await import("../lib/billing/renewal-reminders");
  for (const table of ["subscriptions", "users"]) await authRun(`DELETE FROM ${table}`);
  await authRun(`DELETE FROM app_meta WHERE key LIKE 'renewal%'`);
  process.env.CORTEX_OWNER_EMAIL = "ben@exemple.test";
  const subjects: string[] = [];
  const recipients = new Set<string>();
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const mail = JSON.parse(String(init?.body)) as { to: string; subject: string };
    recipients.add(mail.to);
    subjects.push(mail.subject);
    return new Response("{}", { status: 200 });
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const subscriber = async (user: string, email: string | null, end: string) => {
    await authRun(`INSERT INTO users (id, email) VALUES (?,?)`, user, email);
    await grantSubscriptionMonth({ userId: user, customerId: `cus_${user}`, subscriptionId: `sub_${user}`, plan: "cortex_pro_yearly", periodStart: "2026-10-07 12:00:00", periodEnd: end, at: "2026-10-07 12:00:00" });
  };
  await subscriber("tard", "tard@exemple.test", "2027-08-29 12:00:00"); // à 20 jours de l'échéance, sans rappel
  await subscriber("muet", null, "2027-10-07 12:00:00"); // dans la fenêtre, sans adresse
  const lookup = async () => ({ renews: true, yearly: true, periodEnd: null, amount: 119, currency: "EUR", discounted: false });

  await sendRenewalReminders({ now: at("2027-08-09 07:00:00"), lookup });
  await sendRenewalReminders({ now: at("2027-08-09 07:30:00"), lookup });
  assert.deepEqual(subjects, ["Cortex : rappel de reconduction hors délai (1 abonné)", "Cortex : rappel de reconduction en échec (1 abonné)"]);
  assert.deepEqual([...recipients], ["ben@exemple.test"], "rien au client hors délai, rien à un compte sans adresse");
  await sendRenewalReminders({ now: at("2027-08-10 07:00:00"), lookup });
  assert.deepEqual(subjects.slice(2), ["Cortex : rappel de reconduction en échec (1 abonné)"], "le refus dure : rappelé le lendemain ; le hors délai, lui, est dit une fois");
});
