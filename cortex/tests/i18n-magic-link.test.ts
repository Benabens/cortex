/**
 * E-mail de connexion dans la langue du destinataire : celle de son compte s'il en a une,
 * sinon (première connexion, hors requête) l'anglais. Le français reste mot pour mot l'ancien.
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

async function sent(to: string): Promise<{ subject: string; html: string }> {
  const { sendMagicLink } = await import("../lib/auth-providers");
  const calls: { subject: string; html: string }[] = [];
  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = "re_test";
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await sendMagicLink({ identifier: to, url: "https://app.example.test/api/auth/callback/email?token=t" });
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  }
  return calls[0];
}

test("compte français (adresse en casse différente) : l'e-mail d'avant, mot pour mot", async () => {
  const mail = await sent("etudiante@example.test");
  assert.equal(mail.subject, "Connexion à Cortex");
  assert.equal(mail.html, `<p>Clique pour te connecter à Cortex :</p><p><a href="https://app.example.test/api/auth/callback/email?token=t">Se connecter</a></p><p style="color:#888">Si tu n'es pas à l'origine de cette demande, ignore ce message.</p>`);
});

test("adresse inconnue, hors requête : anglais", async () => {
  const mail = await sent("new@example.test");
  assert.equal(mail.subject, "Sign in to Cortex");
  assert.match(mail.html, /<a href="https:\/\/app\.example\.test\/api\/auth\/callback\/email\?token=t">Sign in<\/a>/);
  assert.doesNotMatch(mail.html, /[àâçéèêîôû]|Clique|ignore ce/);
});
