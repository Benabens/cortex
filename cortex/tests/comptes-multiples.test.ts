/**
 * AUDIT FUITES I8 — COMPTES MULTIPLES. Règle de Ben : un compte qui ne paie pas
 * ne coûte rien, un payant jamais plus que ce qu'il a payé. Ce qui coûte de l'IA
 * (crédits d'inscription, budget d'essai) est donc offert UNE fois par PERSONNE,
 * pas une fois par compte : alias Gmail (points, +étiquette) et domaines jetables
 * ne fabriquent pas de nouvelles personnes.
 *
 * Seams : lib/email-identity (personKey, isDisposableEmail) ; billing :
 * getBalanceCenti, accountBudget, claimFreeOffer ; auth : authCallbacks.signIn.
 * Store PGlite en mémoire, aucun appel au modèle.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

const ENV: Record<string, string> = {
  DB_DRIVER: "postgres",
  DATABASE_URL: "pglite://memory",
  BILLING_ENABLED: "1",
  SIGNUP_FREE_CREDITS: "5",
};
Object.assign(process.env, ENV);
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres?.();
  for (const k of Object.keys(ENV)) delete process.env[k];
});

/** Compte tel que l'adaptateur Auth.js le crée (adresse gardée telle quelle). */
async function account(id: string, email: string) {
  const { authRun } = await import("../db/auth-store");
  await authRun(`INSERT INTO users (id, email) VALUES (?, ?)`, id, email);
}

test("une boîte = une personne : casse, espaces, +étiquette, points et googlemail chez Gmail", async () => {
  const { personKey } = await import("../lib/email-identity");
  const chloe = personKey("chloe.martin@gmail.com");
  for (const alias of ["Chloe.Martin@gmail.com", " chloemartin@gmail.com ", "c.h.l.o.e.martin+cortex@gmail.com", "chloemartin@googlemail.com", "chloe.martin+2@GMAIL.COM"]) {
    assert.equal(personKey(alias), chloe, alias);
  }
  // Ailleurs, les points comptent (deux personnes chez epfl.ch) ; l'étiquette « + », non.
  assert.notEqual(personKey("jean.dupont@epfl.ch"), personKey("jeandupont@epfl.ch"));
  assert.equal(personKey("jean.dupont+cortex@epfl.ch"), personKey("jean.dupont@epfl.ch"));
  assert.notEqual(personKey("chloe@gmail.com"), personKey("chloe@outlook.com"));
});

test("domaines jetables : refusés, sous-domaines compris ; les fournisseurs courants et les écoles passent", async () => {
  const { isDisposableEmail } = await import("../lib/email-identity");
  for (const e of ["x@mailinator.com", "x@YOPMAIL.com", "x@guerrillamail.com", "x@inbox.mailinator.com", " x@yopmail.com "]) {
    assert.equal(await isDisposableEmail(e), true, e);
  }
  for (const e of ["x@gmail.com", "x@outlook.com", "x@proton.me", "x@epfl.ch", "x@unil.ch", "x@icloud.com", "pas-une-adresse"]) {
    assert.equal(await isDisposableEmail(e), false, e);
  }
});

test("crédits d'inscription : une fois par personne, pas une fois par compte (alias Gmail)", async () => {
  const { getBalanceCenti } = await import("../lib/billing/credits");
  await account("chloe-1", "chloe.martin@gmail.com");
  await account("chloe-2", "ChloeMartin+cortex@googlemail.com");
  await account("hugo", "hugo@epfl.ch");
  assert.equal(await getBalanceCenti("chloe-1"), 500, "la première inscription reçoit l'offre");
  assert.equal(await getBalanceCenti("chloe-2"), 0, "l'alias de la même boîte ne la reçoit pas");
  assert.equal(await getBalanceCenti("hugo"), 500, "une autre personne la reçoit");
  assert.equal(await getBalanceCenti("chloe-1"), 500, "idempotent");
});

test("crédits d'inscription : une offre reçue AVANT cette règle compte aussi (pas de second cadeau pour l'alias)", async () => {
  const { addTransaction, getBalanceCenti } = await import("../lib/billing/credits");
  await account("lea-ancien", "lea.roux@gmail.com");
  await addTransaction("lea-ancien", 500, "signup", "signup:lea-ancien", { offered: true });
  await account("lea-nouveau", "learoux@gmail.com");
  assert.equal(await getBalanceCenti("lea-nouveau"), 0);
});

test("budget d'essai (AI_BUDGET_FREE_USD) : une fois par personne ; l'alias ne garde que ce qu'il paie", async () => {
  const { accountBudget } = await import("../lib/billing/budget");
  process.env.AI_BUDGET_FREE_USD = "3";
  try {
    await account("tom-1", "tom.bernard@gmail.com");
    await account("tom-2", "tombernard+essai@gmail.com");
    assert.equal((await accountBudget("tom-1"))?.budgetUsd, 3);
    assert.equal((await accountBudget("tom-2"))?.budgetUsd, 0);
  } finally {
    delete process.env.AI_BUDGET_FREE_USD;
  }
});

test("offres par IP : au plus 3 personnes servies depuis la même IP en 24 h ; le lendemain, ça repart ; sans TRUST_PROXY (« direct »), jamais borné", async () => {
  const { claimFreeOffer } = await import("../lib/billing/free-offer");
  const t0 = Date.parse("2026-11-17T10:00:00Z");
  for (const i of [1, 2, 3, 4, 5]) await account(`ferme-${i}`, `ferme${i}@exemple.ch`);
  for (const i of [1, 2, 3]) assert.deepEqual(await claimFreeOffer(`ferme-${i}`, { ip: "203.0.113.7", now: t0 + i * 1000 }), { ok: true });
  assert.deepEqual(await claimFreeOffer("ferme-4", { ip: "203.0.113.7", now: t0 + 4000 }), { ok: false, reason: "ip_day" });
  assert.deepEqual(await claimFreeOffer("ferme-4", { ip: "203.0.113.7", now: t0 + 25 * 3600_000 }), { ok: true }, "refus par IP non définitif");
  for (const i of [1, 2, 3, 4, 5]) await account(`campus-${i}`, `campus${i}@exemple.ch`);
  for (const i of [1, 2, 3, 4, 5]) assert.deepEqual(await claimFreeOffer(`campus-${i}`, { ip: "direct", now: t0 }), { ok: true });
});

test("adresse jetable : pas d'offre, même pour un compte ouvert avant le refus à l'inscription", async () => {
  const { claimFreeOffer } = await import("../lib/billing/free-offer");
  await account("jetable", "zorg@yopmail.com");
  assert.deepEqual(await claimFreeOffer("jetable"), { ok: false, reason: "disposable" });
});

test("inscription avec une adresse jetable : refusée avec un message clair ; un compte qui existe déjà se connecte toujours", async () => {
  const { authCallbacks } = await import("../lib/auth");
  type SignInArgs = Parameters<typeof authCallbacks.signIn>[0];
  const linkRequest = (email: string) => authCallbacks.signIn({
    user: { id: email, email },
    account: { providerAccountId: email, userId: email, type: "email", provider: "email" },
    email: { verificationRequest: true },
  } as unknown as SignInArgs);
  const google = (email: string) => authCallbacks.signIn({
    user: { id: "g", email }, profile: { email },
    account: { providerAccountId: "sub-123", type: "oidc", provider: "google" },
  } as unknown as SignInArgs);

  assert.equal(await linkRequest("nouveau@yopmail.com"), "/login?error=EmailDisposable");
  assert.equal(await linkRequest("Nouveau@Inbox.Mailinator.com"), "/login?error=EmailDisposable");
  assert.equal(await google("nouveau@guerrillamail.com"), "/login?error=EmailDisposable");
  await account("ancien-jetable", "ancien@yopmail.com");
  assert.equal(await linkRequest("ancien@yopmail.com"), true, "compte existant : la connexion reste ouverte");
  assert.equal(await linkRequest("nouvelle@epfl.ch"), true);
  assert.equal(await google("nouvelle@gmail.com"), true);
});

test("la page de connexion explique le refus d'une adresse jetable", async () => {
  const fs = await import("node:fs");
  const card = fs.readFileSync("app/login/LoginCard.tsx", "utf8");
  assert.match(card, /case "EmailDisposable":\s*return t\("errorEmailDisposable"\);/);
  const messages = (lang: string) => JSON.parse(fs.readFileSync(`messages/${lang}.json`, "utf8")).login.errorEmailDisposable as string;
  assert.equal(messages("fr"), "Les adresses e-mail jetables ne permettent pas d’ouvrir un compte. Utilise ton adresse habituelle (école, Gmail, Outlook…).");
  assert.match(messages("en"), /Disposable email addresses/);
});

test("budget d'essai : un compte qui paie n'y touche pas (jamais plus que ce qu'il a payé) et ne prend pas de place d'offre", async () => {
  const { accountBudget } = await import("../lib/billing/budget");
  const { claimFreeOffer } = await import("../lib/billing/free-offer");
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  await account("pia-paie", "pia@exemple.ch");
  await handleStripeEvent({
    id: "evt_pia", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: {
      id: "cs_pia", mode: "payment", payment_status: "paid", payment_intent: "pi_pia", amount_total: 1000, currency: "usd",
      metadata: { cortexUserId: "pia-paie", plan: "credits_10", credits: "10" },
    } },
  } as never, { lookup: { async sessionByPaymentIntent() { return null; }, async paymentDetails() { return { feeCents: 0 }; } } });
  process.env.AI_BUDGET_FREE_USD = "3";
  try {
    assert.equal((await accountBudget("pia-paie"))?.budgetUsd, 6, "0,6 × 10 $ payés, sans l'essai");
    await account("pia-essai", "pia+essai@exemple.ch");
    assert.deepEqual(await claimFreeOffer("pia-essai"), { ok: true }, "la personne n'a pas encore utilisé son essai");
  } finally {
    delete process.env.AI_BUDGET_FREE_USD;
  }
});

test("offres par IP en IPv6 : une connexion (/64) compte pour une seule IP", async () => {
  const { claimFreeOffer } = await import("../lib/billing/free-offer");
  const t0 = Date.parse("2026-11-18T10:00:00Z");
  const ips = ["2001:db8:1:2::a", "2001:DB8:1:2:0:0:0:b", "2001:db8:1:2:ffff::1", "2001:db8:1:2::c"];
  for (const i of [0, 1, 2, 3]) await account(`v6-${i}`, `v6-${i}@exemple.ch`);
  for (const i of [0, 1, 2]) assert.deepEqual(await claimFreeOffer(`v6-${i}`, { ip: ips[i], now: t0 + i }), { ok: true });
  assert.deepEqual(await claimFreeOffer("v6-3", { ip: ips[3], now: t0 + 3 }), { ok: false, reason: "ip_day" });
  await account("v6-voisin", "v6-voisin@exemple.ch");
  assert.deepEqual(await claimFreeOffer("v6-voisin", { ip: "2001:db8:1:3::a", now: t0 + 4 }), { ok: true }, "un autre /64");
});
