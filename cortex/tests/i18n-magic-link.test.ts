/**
 * E-mail de connexion dans la langue du destinataire : celle de son compte s'il en a une,
 * sinon (première connexion, hors requête) l'anglais. Mis en forme comme les autres e-mails de Cortex
 * (lib/email-frame) depuis le 22/11/2026 : il partait en trois paragraphes nus, lu comme du texte brut.
 */
import assert from "node:assert/strict";
import { before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-magic-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.AUTH_ENABLED = "1";
delete process.env.CORTEX_USER;

before(async () => {
  const { authRun } = await import("../db/auth-store");
  await authRun(`INSERT INTO users (id, email, locale) VALUES ($1, $2, $3)`, "u-fr", "Etudiante@Example.test", "fr");
});

type Sent = { subject: string; html: string; text: string };
const URL = "https://app.example.test/api/auth/callback/email?token=t";

async function sent(to: string): Promise<Sent> {
  const { sendMagicLink } = await import("../lib/auth-providers");
  const calls: Sent[] = [];
  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "re_test";
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await sendMagicLink({ identifier: to, url: URL });
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  }
  return calls[0];
}

test("compte français (adresse en casse différente) : e-mail en français, au gabarit de Cortex", async () => {
  const mail = await sent("etudiante@example.test");
  assert.equal(mail.subject, "Connexion à Cortex");
  assert.match(mail.html, /^<!doctype html><html lang="fr">/);
  assert.match(mail.html, /background:#0d0b14/, "fond sombre des e-mails Cortex");
  assert.match(mail.html, />cortex\.<\/p>/, "le mot-symbole");
  // Le bouton, puis le même lien en clair pour un client qui n'affiche pas les boutons.
  assert.match(mail.html, /<a href="https:\/\/app\.example\.test\/api\/auth\/callback\/email\?token=t" style="[^"]*display:inline-block[^"]*">Se connecter<\/a>/);
  assert.equal(mail.html.split(`href="${URL}"`).length - 1, 2);
  assert.match(mail.html, /valable 24 heures/);
  assert.match(mail.html, /ignore ce message/);
  assert.match(mail.text, /Se connecter : https:\/\/app\.example\.test\/api\/auth\/callback\/email\?token=t/);
  assert.doesNotMatch(mail.text, /</, "version texte sans balise");
});

test("adresse inconnue, hors requête : anglais", async () => {
  const mail = await sent("new@example.test");
  assert.equal(mail.subject, "Sign in to Cortex");
  assert.match(mail.html, /^<!doctype html><html lang="en">/);
  assert.match(mail.html, /<a href="https:\/\/app\.example\.test\/api\/auth\/callback\/email\?token=t" style="[^"]*">Sign in<\/a>/);
  assert.match(mail.html, /valid for 24 hours/);
  assert.match(mail.text, /Sign in: https:\/\/app/);
  assert.doesNotMatch(mail.html + mail.text, /[àâçéèêîôû]|Clique|ignore ce/);
});

test("un lien qui porte des caractères HTML est échappé dans le HTML, intact dans le texte", async () => {
  const { magicLinkMail } = await import("../lib/magic-link-mail");
  const mail = magicLinkMail("en", `https://app.example.test/cb?a=1&b="x"`);
  assert.match(mail.html, /href="https:\/\/app\.example\.test\/cb\?a=1&#38;b=&#34;x&#34;"/);
  assert.doesNotMatch(mail.html, /b="x"/);
  assert.match(mail.text, /cb\?a=1&b="x"/);
});

test("le cadre partagé ne change pas d'un octet les e-mails de renouvellement", async () => {
  const { renewalReminderEmail } = await import("../lib/billing/renewal-reminders");
  const o = { renewsAt: "2027-03-01 10:00:00", amount: 4900, currency: "eur", accountUrl: "https://app.example.test/compte", contact: "contact@example.test", termsUrl: "https://example.test/cgv" };
  const crypto = await import("node:crypto");
  const h = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
  assert.deepEqual([h(renewalReminderEmail(o).html), h(renewalReminderEmail({ ...o, locale: "en" }).html)], RENEWAL_FINGERPRINTS);
});

/** Empreintes du rendu d'avant le cadre partagé (main 7ef540c). */
const RENEWAL_FINGERPRINTS = ["b1d3568be3701416", "72056cd8dfeb4290"];
