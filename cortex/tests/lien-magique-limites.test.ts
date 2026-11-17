/**
 * AUDIT FUITES DU 17/11, B4 — le lien magique partait à chaque demande, sans limite par adresse
 * ni par IP : un script qui boucle sur /api/auth/signin/email vide le quota Resend (ou fait
 * suspendre le compte) et plus personne ne se connecte par e-mail. Désormais, en base (vaut pour
 * tous les process et survit à un redémarrage) : 1 lien par minute et 5 par jour par adresse,
 * 20 par heure par IP. La limite par IP n'existe que derrière TRUST_PROXY : sans lui, toutes
 * les requêtes partagent la clé « direct », et la borner bloquerait tout le site d'un coup.
 *
 * Seams : takeMagicLinkSend (décision), authCallbacks.signIn (demande de lien), boot-guards.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-lien-magique-"));
process.env.CORTEX_DATA_DIR = tmp;
for (const k of ["MAGIC_LINK_PER_MINUTE", "MAGIC_LINK_PER_DAY", "MAGIC_LINK_PER_IP_HOUR", "INVITE_ONLY"]) delete process.env[k];

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-17T10:00:00Z");
const MIN = 60_000;

test("même adresse : un lien par minute, le suivant passe une minute plus tard", async () => {
  const { takeMagicLinkSend } = await import("../lib/magic-link-limits");
  assert.deepEqual(await takeMagicLinkSend("ana@exemple.ch", "1.1.1.1", T0), { ok: true });
  assert.deepEqual(await takeMagicLinkSend("ana@exemple.ch", "2.2.2.2", T0 + 30_000), { ok: false, reason: "address_minute" });
  assert.deepEqual(await takeMagicLinkSend("ana@exemple.ch", "1.1.1.1", T0 + MIN + 1000), { ok: true });
});

test("même adresse : 5 liens par jour au plus, de nouveau possible 24 h après", async () => {
  const { takeMagicLinkSend } = await import("../lib/magic-link-limits");
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(await takeMagicLinkSend("bob@exemple.ch", `3.3.3.${i}`, T0 + i * 2 * MIN), { ok: true }, `lien ${i + 1}`);
  }
  assert.deepEqual(await takeMagicLinkSend("bob@exemple.ch", "3.3.3.9", T0 + 20 * MIN), { ok: false, reason: "address_day" });
  assert.deepEqual(await takeMagicLinkSend("bob@exemple.ch", "3.3.3.9", T0 + 24 * 60 * MIN + 10 * MIN), { ok: true });
});

test("l'adresse est comptée sans casse ni espaces (Bob@… et bob@… sont la même boîte)", async () => {
  const { takeMagicLinkSend } = await import("../lib/magic-link-limits");
  assert.deepEqual(await takeMagicLinkSend("Chloe@Exemple.ch", "4.4.4.4", T0), { ok: true });
  assert.deepEqual(await takeMagicLinkSend(" chloe@exemple.ch ", "4.4.4.5", T0 + 1000), { ok: false, reason: "address_minute" });
  // chloe+1@, chloe+2@… arrivent dans la même boîte : l'étiquette ne donne pas de nouveaux liens.
  assert.deepEqual(await takeMagicLinkSend("chloe+1@exemple.ch", "4.4.4.6", T0 + 2000), { ok: false, reason: "address_minute" });
});

test("même IP : 20 liens par heure, toutes adresses confondues ; une autre IP n'est pas touchée", async () => {
  const { takeMagicLinkSend } = await import("../lib/magic-link-limits");
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(await takeMagicLinkSend(`robot${i}@jetable.io`, "6.6.6.6", T0 + i * 1000), { ok: true }, `adresse ${i + 1}`);
  }
  assert.deepEqual(await takeMagicLinkSend("robot20@jetable.io", "6.6.6.6", T0 + 21_000), { ok: false, reason: "ip_hour" });
  assert.deepEqual(await takeMagicLinkSend("robot20@jetable.io", "7.7.7.7", T0 + 22_000), { ok: true });
  assert.deepEqual(await takeMagicLinkSend("robot21@jetable.io", "6.6.6.6", T0 + 61 * MIN), { ok: true }, "une heure plus tard");
});

test("sans TRUST_PROXY (clé « direct ») : aucune limite par IP, qui serait commune à tout le site", async () => {
  const { takeMagicLinkSend } = await import("../lib/magic-link-limits");
  for (let i = 0; i < 25; i++) {
    assert.deepEqual(await takeMagicLinkSend(`etudiant${i}@epfl.ch`, "direct", T0 + i * 1000), { ok: true }, `adresse ${i + 1}`);
  }
});

test("demande de lien refusée : le rappel signIn renvoie vers /login avec un code clair, sans envoyer", async () => {
  const { authCallbacks } = await import("../lib/auth");
  const request = (email: string) => authCallbacks.signIn({
    user: { id: "u", email },
    account: { providerAccountId: email, userId: "u", type: "email", provider: "email" },
    email: { verificationRequest: true },
  } as unknown as Parameters<typeof authCallbacks.signIn>[0]);
  assert.equal(await request("dora@exemple.ch"), true);
  assert.equal(await request("dora@exemple.ch"), "/login?error=EmailWait");
  // Le clic sur le lien reçu (verificationRequest absent) n'est jamais compté ni bloqué.
  const click = await authCallbacks.signIn({
    user: { id: "u", email: "dora@exemple.ch" },
    account: { providerAccountId: "dora@exemple.ch", userId: "u", type: "email", provider: "email" },
  } as unknown as Parameters<typeof authCallbacks.signIn>[0]);
  assert.equal(click, true);
});

test("instance hébergée sans TRUST_PROXY : refus de démarrer (sinon toutes les limites par IP deviennent globales)", async () => {
  const { assertTrustProxyHosted } = await import("../lib/boot-guards");
  assert.throws(() => assertTrustProxyHosted({ RAILWAY_ENVIRONMENT_NAME: "production" }), /TRUST_PROXY/);
  assert.throws(() => assertTrustProxyHosted({ CORTEX_HOSTED: "1", TRUST_PROXY: "0" }), /TRUST_PROXY/);
  assert.throws(() => assertTrustProxyHosted({ CORTEX_HOSTED: "1", TRUST_PROXY: "oui" }), /TRUST_PROXY/);
  assert.doesNotThrow(() => assertTrustProxyHosted({ RAILWAY_ENVIRONMENT_NAME: "production", TRUST_PROXY: "1" }));
  assert.doesNotThrow(() => assertTrustProxyHosted({}), "banc local : rien à exiger");
});
