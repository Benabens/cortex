/**
 * E-mail de connexion dans la langue du destinataire : celle de son compte s'il en a une,
 * sinon (première connexion, hors requête) l'anglais. Mis en forme comme les autres e-mails de Cortex
 * (lib/email-frame, celui du reçu #179) depuis le 22/11/2026 : il partait en trois paragraphes nus, lu comme du texte brut.
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
  assert.match(mail.html, /background:#080c14/, "fond sombre des e-mails Cortex (celui du reçu)");
  assert.match(mail.html, />cortex<span style="color:#2764ec">\.<\/span>/, "le mot-symbole");
  // Le bouton, puis le même lien en clair pour un client qui n'affiche pas les boutons.
  assert.match(mail.html, /<a href="https:\/\/app\.example\.test\/api\/auth\/callback\/email\?token=t" style="[^"]*display:inline-block[^"]*">Se connecter<\/a>/);
  assert.equal(mail.html.split(`href="${URL}"`).length - 1, 2);
  assert.match(mail.html, /valable 24 heures/);
  assert.match(mail.html, /Ignorez ce message/);
  assert.doesNotMatch(mail.html + mail.text, /(?<!\p{L})(?:tu|te|ton|ta|tes|Clique|Copie)(?!\p{L})/u, "vouvoiement, comme les autres e-mails");
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
  assert.doesNotMatch(mail.html + mail.text, /[àâçéèêîôû]|Cliquez|Ignorez/);
});

test("un lien qui porte des caractères HTML est échappé dans le HTML, intact dans le texte", async () => {
  const { magicLinkMail } = await import("../lib/magic-link-mail");
  const mail = magicLinkMail("en", `https://app.example.test/cb?a=1&b="x"`);
  assert.match(mail.html, /href="https:\/\/app\.example\.test\/cb\?a=1&#38;b=&#34;x&#34;"/);
  assert.doesNotMatch(mail.html, /b="x"/);
  assert.match(mail.text, /cb\?a=1&b="x"/);
});

test("le cadre partagé ne change pas d'un octet le reçu (#179), FR et EN", async () => {
  const { receiptEmail } = await import("../lib/billing/receipt-email");
  const order = {
    number: "B3A1C2D4-0042", kind: "subscription", plan: "pro_yearly", currency: "eur", subtotal: 9900,
    discounts: [{ name: "BIENVENUE", amount: 1000 }], total: 8900, amountPaid: 8900, paidAt: 1795000000, issuedAt: 1795000000,
    period: { start: 1795000000, end: 1826536000 }, customer: { name: null, email: null, address: [] },
  } as unknown as import("../lib/billing/orders").Order;
  const opts = { accountUrl: "https://app.example.test/compte", invoiceUrl: "https://app.example.test/api/billing/invoices/cs_1", contact: "contact@example.test" };
  const crypto = await import("node:crypto");
  const h = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
  assert.deepEqual([h(receiptEmail(order, { ...opts, locale: "fr" }).html), h(receiptEmail(order, { ...opts, locale: "en" }).html)], RECEIPT_FINGERPRINTS);
});

/** Empreintes du reçu d'avant le cadre partagé (main d8c07f17). */
const RECEIPT_FINGERPRINTS = ["58e24aba2f7ca263", "4d0a15a806d6c3ac"];
