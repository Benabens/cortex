/**
 * MARQUE CORTEX côté acheteur (compte Stripe partagé avec Kairo) : la page de
 * paiement porte Cortex par session, le reçu et la facture sont ceux de Cortex,
 * une réduction s'affiche par son nom, jamais par l'id du coupon.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-marque-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "0";

test("page de paiement : Cortex, son logo, son icône et ses couleurs sur chaque offre", async () => {
  process.env.AUTH_URL = "https://app.cortexexam.com/";
  const { checkoutParams } = await import("../lib/billing/checkout-params");
  for (const plan of ["credits_10", "pro_monthly", "pro_yearly"] as const) {
    const p = checkoutParams({ plan, priceId: "price_test", userId: "alice", email: "alice@example.com" });
    assert.deepEqual(p.branding_settings, {
      display_name: "Cortex",
      logo: { type: "url", url: "https://app.cortexexam.com/brand/cortex-lockup-dark.png" },
      icon: { type: "url", url: "https://app.cortexexam.com/brand/icon-512.png" },
      background_color: "#080c14",
      button_color: "#2764ec",
      border_style: "rounded",
      font_family: "default",
    }, plan);
  }
});

test("page de paiement en local (http) : le nom et les couleurs, pas d'image que Stripe ne pourrait pas lire", async () => {
  process.env.AUTH_URL = "http://localhost:3000";
  const { checkoutParams } = await import("../lib/billing/checkout-params");
  const p = checkoutParams({ plan: "credits_10", priceId: "price_test", userId: "alice" });
  assert.equal(p.branding_settings?.display_name, "Cortex");
  assert.equal(p.branding_settings?.logo, undefined);
  assert.equal(p.branding_settings?.icon, undefined);
  process.env.AUTH_URL = "https://app.cortexexam.com/";
});

test("les images de la page de paiement sont servies sans session, et au format que Stripe accepte", async () => {
  const pub = path.join(__dirname, "..", "public");
  for (const [file, square] of [["brand/cortex-lockup-dark.png", false], ["brand/icon-512.png", true]] as const) {
    const buf = fs.readFileSync(path.join(pub, file));
    assert.equal(buf.subarray(1, 4).toString(), "PNG", file);
    assert.ok(buf.length < 512 * 1024, `${file} : 512 Ko au plus chez Stripe`);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    assert.ok(Math.min(w, h) >= 128 || !square, `${file} : 128 px au moins`);
    if (square) assert.equal(w, h, file);
  }
  const proxy = fs.readFileSync(path.join(__dirname, "..", "proxy.ts"), "utf8");
  assert.match(proxy, /"\/brand\/"/, "public/brand est servi sans session (Stripe le télécharge)");
});

/** Facture Stripe telle que l'API (version épinglée) la rend, réductions déployées. */
function fakeInvoice(over: Record<string, unknown> = {}): import("stripe").default.Invoice {
  return {
    id: "in_test_1", object: "invoice", number: "B3A1C2D4-0042", currency: "eur", status: "paid",
    created: 1795000000, period_start: 1795000000, period_end: 1795000000,
    subtotal: 900, total: 630, amount_paid: 630,
    status_transitions: { paid_at: 1795003600, finalized_at: 1795000100, marked_uncollectible_at: null, voided_at: null },
    customer_name: "Alice Martin", customer_email: "alice@example.com",
    customer_address: { line1: "12 rue des Lilas", line2: null, postal_code: "75011", city: "Paris", state: null, country: "FR" },
    billing_reason: "manual",
    lines: { object: "list", data: [{ id: "il_1", description: "Cortex : pack de 10 crédits", quantity: 1, amount: 900, subtotal: 900, period: { start: 1795000000, end: 1795000000 } }] },
    total_discount_amounts: [{ amount: 270, discount: { id: "di_1", object: "discount", source: { type: "coupon", coupon: { id: "QxJO9DZs", object: "coupon", name: "Bienvenue -30 %" } }, promotion_code: null } }],
    ...over,
  } as unknown as import("stripe").default.Invoice;
}

test("commande lue sur la facture Stripe : numéro, ligne, réduction par son NOM, payé, client", async () => {
  const { orderFromInvoice } = await import("../lib/billing/orders");
  const o = orderFromInvoice(fakeInvoice(), { kind: "pack" });
  assert.equal(o.number, "B3A1C2D4-0042");
  assert.equal(o.plan, "credits_10");
  assert.deepEqual(o.discounts, [{ name: "Bienvenue -30 %", amount: 270 }]);
  assert.equal(o.subtotal, 900);
  assert.equal(o.amountPaid, 630);
  assert.equal(o.paidAt, 1795003600);
  assert.deepEqual(o.customer, { name: "Alice Martin", email: "alice@example.com", address: ["12 rue des Lilas", "75011 Paris", "FR"] });
});

test("réduction sans nom : le code promo saisi, sinon « Réduction » — jamais l'id du coupon", async () => {
  const { orderFromInvoice } = await import("../lib/billing/orders");
  const withCode = orderFromInvoice(fakeInvoice({ total_discount_amounts: [{ amount: 270, discount: { id: "di_2", object: "discount", source: { type: "coupon", coupon: { id: "QxJO9DZs", name: null } }, promotion_code: { id: "promo_1", code: "RENTREE26" } } }] }), { kind: "pack" });
  assert.deepEqual(withCode.discounts, [{ name: "RENTREE26", amount: 270 }]);
  const bare = orderFromInvoice(fakeInvoice({ total_discount_amounts: [{ amount: 270, discount: "di_3" }] }), { kind: "pack" });
  assert.deepEqual(bare.discounts, [{ name: null, amount: 270 }]);
  const { receiptEmail } = await import("../lib/billing/receipt-email");
  const mail = receiptEmail(bare, { locale: "fr", accountUrl: "https://app.cortexexam.com/compte", invoiceUrl: "https://app.cortexexam.com/api/billing/invoices/cs_1", contact: "contact@cortexexam.com" });
  assert.ok(!/QxJO9DZs|di_3/.test(mail.text + mail.html));
  assert.match(mail.text, /Réduction/);
});

test("abonnement : annuel ou mensuel selon la période facturée, période affichée", async () => {
  const { orderFromInvoice } = await import("../lib/billing/orders");
  const line = (days: number) => ({ id: "il_s", description: "1 × Cortex Pro (at €149.00 / year)", quantity: 1, amount: 14900, subtotal: 14900, period: { start: 1795000000, end: 1795000000 + days * 86400 } });
  const yearly = orderFromInvoice(fakeInvoice({ lines: { data: [line(365)] }, total_discount_amounts: [], subtotal: 14900, total: 14900, amount_paid: 14900, billing_reason: "subscription_create" }), { kind: "subscription" });
  assert.equal(yearly.plan, "pro_yearly");
  assert.deepEqual(yearly.period, { start: 1795000000, end: 1795000000 + 365 * 86400 });
  const monthly = orderFromInvoice(fakeInvoice({ lines: { data: [line(30)] }, total_discount_amounts: [] }), { kind: "subscription" });
  assert.equal(monthly.plan, "pro_monthly");
  // Le plan connu du webhook prime sur la déduction.
  assert.equal(orderFromInvoice(fakeInvoice({ lines: { data: [line(30)] } }), { kind: "subscription", plan: "pro_yearly" }).plan, "pro_yearly");
});

test("e-mail de reçu, en français : produit, montant payé, date, n° de commande, réduction ; aucune mention du vendeur", async () => {
  const { orderFromInvoice } = await import("../lib/billing/orders");
  const { receiptEmail } = await import("../lib/billing/receipt-email");
  const mail = receiptEmail(orderFromInvoice(fakeInvoice(), { kind: "pack" }), {
    locale: "fr", accountUrl: "https://app.cortexexam.com/compte", invoiceUrl: "https://app.cortexexam.com/api/billing/invoices/cs_1", contact: "contact@cortexexam.com",
  });
  assert.equal(mail.subject, "Votre reçu Cortex : pack de 10 crédits");
  for (const part of [mail.text, mail.html]) {
    assert.match(part, /Pack de 10 crédits/);
    assert.match(part, /6,30\s€/);
    assert.match(part, /Bienvenue -30 %/);
    assert.match(part, /−2,70\s€/);
    assert.match(part, /B3A1C2D4-0042/);
    assert.match(part, /2026/);
    assert.match(part, /https:\/\/app\.cortexexam\.com\/compte/);
    assert.match(part, /https:\/\/app\.cortexexam\.com\/api\/billing\/invoices\/cs_1/);
    assert.doesNotMatch(part, /Benabens|Abensur|SIRE[NT]|293 B|QxJO9DZs/i);
  }
  assert.match(mail.html, /^<!doctype html><html lang="fr">/);
});

test("e-mail de reçu, en anglais", async () => {
  const { orderFromInvoice } = await import("../lib/billing/orders");
  const { receiptEmail } = await import("../lib/billing/receipt-email");
  const mail = receiptEmail(orderFromInvoice(fakeInvoice({ total_discount_amounts: [], total: 900, amount_paid: 900 }), { kind: "pack" }), {
    locale: "en", accountUrl: "https://app.cortexexam.com/compte", invoiceUrl: "https://app.cortexexam.com/api/billing/invoices/cs_1", contact: "contact@cortexexam.com",
  });
  assert.equal(mail.subject, "Your Cortex receipt: 10-credit pack");
  assert.match(mail.text, /€9\.00/);
  assert.match(mail.html, /lang="en"/);
  assert.doesNotMatch(mail.text, /Discount/);
});

// ─────────────── reçu Cortex : du webhook à l'e-mail, une fois par paiement ───────────────

type Sent = { to: string; subject: string; text: string; html?: string; idempotencyKey?: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (id: string, type: string, object: unknown): any => ({ id, type, livemode: false, created: 1795003600, data: { object } });
const paidPack = (id: string, user: string, invoice: string | null = `in_${id}`) => ev(`evt_${id}`, "checkout.session.completed", {
  id: `cs_${id}`, mode: "payment", payment_status: "paid", amount_total: 630, currency: "eur", payment_intent: `pi_${id}`, invoice,
  metadata: { app: "cortex", cortexUserId: user, plan: "credits_10", credits: "10" },
});

function fakeStripe(invoices: Record<string, import("stripe").default.Invoice>, sessions: Record<string, string | null> = {}) {
  const calls: Array<{ id: string; expand?: string[] }> = [];
  return {
    calls,
    invoices: { async retrieve(id: string, p?: { expand?: string[] }) { calls.push({ id, expand: p?.expand }); const inv = invoices[id]; if (!inv) throw Object.assign(new Error("No such invoice"), { statusCode: 404 }); return inv; } },
    checkout: { sessions: { async retrieve(id: string) { return { invoice: sessions[id] ?? null }; } } },
  };
}
function mailbox(outcomes: Array<import("../lib/email").EmailOutcome> = []) {
  const sent: Sent[] = [];
  return { sent, send: async (m: Sent) => { sent.push(m); return outcomes.shift() ?? { ok: true as const }; } };
}

async function user(id: string, locale: string | null) {
  const { authRun } = await import("../db/auth-store");
  await authRun(`INSERT INTO users (id, email, name) VALUES (?,?,?)`, id, `${id}@example.com`, id);
  if (locale) await authRun(`UPDATE users SET locale = ? WHERE id = ?`, locale, id);
}

test("pack payé : un reçu Cortex à l'adresse du compte, dans sa langue, une seule fois", async () => {
  process.env.AUTH_URL = "https://app.cortexexam.com/";
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  const { sendPendingReceipts } = await import("../lib/billing/receipts");
  await user("rc-fr", "fr");
  const r = await handleStripeEvent(paidPack("p1", "rc-fr"));
  assert.equal(r.credited, true);
  const stripe = fakeStripe({ in_p1: fakeInvoice({ id: "in_p1" }) });
  const box = mailbox();
  assert.deepEqual(await sendPendingReceipts({ stripe, send: box.send }), { sent: 1, pending: 0, failed: 0 });
  assert.equal(box.sent.length, 1);
  assert.equal(box.sent[0].to, "rc-fr@example.com");
  assert.equal(box.sent[0].subject, "Votre reçu Cortex : pack de 10 crédits");
  assert.match(box.sent[0].text, /Bienvenue -30 %/);
  assert.match(box.sent[0].text, /https:\/\/app\.cortexexam\.com\/api\/billing\/invoices\/cs_p1/);
  assert.ok(stripe.calls[0].expand?.includes("total_discount_amounts.discount.source.coupon"), "le nom des réductions est déployé");
  // Rejeu Stripe du même événement, nouveau passage : rien de plus.
  await handleStripeEvent(paidPack("p1", "rc-fr"));
  assert.deepEqual(await sendPendingReceipts({ stripe, send: box.send }), { sent: 0, pending: 0, failed: 0 });
  assert.equal(box.sent.length, 1);
});

test("abonnement payé (invoice.paid) : reçu en anglais pour un compte anglais", async () => {
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  const { sendPendingReceipts } = await import("../lib/billing/receipts");
  await user("rc-en", "en");
  await handleStripeEvent(ev("evt_s1_co", "checkout.session.completed", { id: "cs_s1", mode: "subscription", customer: "cus_s1", subscription: "sub_s1", metadata: { app: "cortex", cortexUserId: "rc-en", plan: "pro_monthly" } }));
  const end = Math.floor(Date.now() / 1000) + 30 * 86400;
  await handleStripeEvent(ev("evt_s1_inv", "invoice.paid", {
    id: "in_s1", customer: "cus_s1", subscription: "sub_s1", payment_intent: "pi_s1", amount_paid: 1490, total: 1490, currency: "eur", livemode: false,
    lines: { data: [{ period: { start: end - 30 * 86400, end }, price: { lookup_key: "cortex_pro_monthly" } }] },
  }));
  const line = { id: "il_s1", quantity: 1, amount: 1490, subtotal: 1490, period: { start: end - 30 * 86400, end } };
  const box = mailbox();
  await sendPendingReceipts({ stripe: fakeStripe({ in_s1: fakeInvoice({ id: "in_s1", lines: { data: [line] }, total_discount_amounts: [], subtotal: 1490, total: 1490, amount_paid: 1490 }) }), send: box.send });
  assert.equal(box.sent.length, 1);
  assert.equal(box.sent[0].subject, "Your Cortex receipt: Pro monthly subscription");
  assert.match(box.sent[0].text, /€14\.90/);
  assert.match(box.sent[0].text, /Period/);
});

test("facture pas encore finalisée chez Stripe : le reçu attend, puis part", async () => {
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  const { sendPendingReceipts } = await import("../lib/billing/receipts");
  await user("rc-wait", null);
  // L'événement de la session n'a pas encore l'id de la facture : on le relit sur la session.
  await handleStripeEvent(paidPack("p2", "rc-wait", null));
  const box = mailbox();
  const draft = fakeStripe({ in_p2: fakeInvoice({ id: "in_p2", number: null, status: "draft" }) }, { cs_p2: "in_p2" });
  assert.deepEqual(await sendPendingReceipts({ stripe: draft, send: box.send, only: "cs_p2" }), { sent: 0, pending: 1, failed: 0 });
  assert.equal(box.sent.length, 0);
  const ready = fakeStripe({ in_p2: fakeInvoice({ id: "in_p2" }) }, { cs_p2: "in_p2" });
  assert.deepEqual(await sendPendingReceipts({ stripe: ready, send: box.send, only: "cs_p2" }), { sent: 1, pending: 0, failed: 0 });
  // Compte sans langue choisie : français, la langue du contrat.
  assert.equal(box.sent[0].subject, "Votre reçu Cortex : pack de 10 crédits");
});

test("Resend : issue inconnue → reprise sous la MÊME clé ; refus net → nouvel essai sous une autre clé", async () => {
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  const { sendPendingReceipts } = await import("../lib/billing/receipts");
  const { authRun } = await import("../db/auth-store");
  await user("rc-retry", "fr");
  await handleStripeEvent(paidPack("p3", "rc-retry"));
  const stripe = fakeStripe({ in_p3: fakeInvoice({ id: "in_p3" }) });
  const box = mailbox([{ ok: false, reason: "délai dépassé", uncertain: true }, { ok: false, reason: "HTTP 503", status: 503 }, { ok: true }]);
  assert.deepEqual(await sendPendingReceipts({ stripe, send: box.send, only: "cs_p3" }), { sent: 0, pending: 1, failed: 0 });
  // Réclamation restée en cours : un process mort. Passé le délai, la reprise garde la chaîne.
  await authRun(`UPDATE app_meta SET value = ? || substr(value, 25) WHERE key = ?`, "2020-01-01T00:00:00.000Z", "receipt:cs_p3");
  await sendPendingReceipts({ stripe, send: box.send, only: "cs_p3" });
  await sendPendingReceipts({ stripe, send: box.send, only: "cs_p3" });
  assert.equal(box.sent.length, 3);
  assert.equal(box.sent[0].idempotencyKey, box.sent[1].idempotencyKey, "issue inconnue : même clé (Resend écarte le doublon)");
  assert.notEqual(box.sent[1].idempotencyKey, box.sent[2].idempotencyKey, "après un refus net : nouvelle clé");
  assert.deepEqual(await sendPendingReceipts({ stripe, send: box.send, only: "cs_p3" }), { sent: 0, pending: 0, failed: 0 });
});

test("paiement d'une autre application du compte (Kairo), pack offert à 0 € : aucun reçu Cortex", async () => {
  const { handleStripeEvent } = await import("../lib/billing/stripe-events");
  const { sendPendingReceipts } = await import("../lib/billing/receipts");
  await handleStripeEvent(ev("evt_k1", "checkout.session.completed", { id: "cs_k1", mode: "payment", payment_status: "paid", amount_total: 900, metadata: { app: "kairo", userId: "x" } }));
  await user("rc-free", "fr");
  process.env.STRIPE_FREE_PROMO_CODES = "promo_FREE";
  await handleStripeEvent(ev("evt_free", "checkout.session.completed", {
    id: "cs_free", mode: "payment", payment_status: "no_payment_required", amount_total: 0, metadata: { app: "cortex", cortexUserId: "rc-free", plan: "credits_10", credits: "10" },
    discounts: [{ promotion_code: "promo_FREE" }],
  }));
  delete process.env.STRIPE_FREE_PROMO_CODES;
  const box = mailbox();
  await sendPendingReceipts({ stripe: fakeStripe({}), send: box.send });
  assert.equal(box.sent.length, 0);
});

// ─────────────── facture PDF : mentions légales du vendeur, sur la facture seulement ───────────────

const SELLER_ENV = {
  INVOICE_SELLER_NAME: "Camille Durand EI",
  INVOICE_SELLER_ADDRESS: "3 place de l'Exemple|67000 Strasbourg|France",
  INVOICE_SELLER_SIRET: "123 456 789 00012",
};

async function pdfText(buf: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(doc, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n") : text).replace(/\s+/g, " ");
}

test("vendeur de la facture : nom avec la mention EI, adresse et SIRET exigés ; sinon la facture est refusée", async () => {
  const { invoiceSeller } = await import("../lib/billing/invoice-pdf");
  assert.deepEqual(invoiceSeller(SELLER_ENV), {
    ok: true,
    seller: { name: "Camille Durand EI", address: ["3 place de l'Exemple", "67000 Strasbourg", "France"], siret: "123 456 789 00012", registration: null, vatNote: "TVA non applicable, art. 293 B du CGI" },
  });
  assert.equal(invoiceSeller({ ...SELLER_ENV, INVOICE_SELLER_ADDRESS: "" }).ok, false);
  assert.equal(invoiceSeller({ ...SELLER_ENV, INVOICE_SELLER_SIRET: "12345" }).ok, false, "SIREN (9 chiffres) ou SIRET (14)");
  const noEi = invoiceSeller({ ...SELLER_ENV, INVOICE_SELLER_NAME: "Camille Durand" });
  assert.equal(noEi.ok, false, "« EI » ou « entrepreneur individuel » obligatoire depuis 2022");
});

test("facture PDF : numéro Stripe, vendeur (EI, adresse, SIRET), client, désignation, réduction nommée, mention 293 B", async () => {
  const { orderFromInvoice } = await import("../lib/billing/orders");
  const { invoicePdf, invoiceSeller } = await import("../lib/billing/invoice-pdf");
  const seller = invoiceSeller(SELLER_ENV);
  assert.ok(seller.ok);
  const buf = invoicePdf(orderFromInvoice(fakeInvoice(), { kind: "pack" }), seller.seller, "fr");
  assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
  const text = await pdfText(buf);
  for (const want of [
    "Facture", "B3A1C2D4-0042", "Camille Durand EI", "3 place de l'Exemple", "67000 Strasbourg", "SIRET 123 456 789 00012",
    "Alice Martin", "12 rue des Lilas", "Pack de 10 crédits", "Bienvenue -30 %", "9,00 €", "2,70 €", "6,30 €",
    "TVA non applicable, art. 293 B du CGI", "cortex",
  ]) assert.ok(text.includes(want), `« ${want} » absent de : ${text}`);
  assert.doesNotMatch(text, /QxJO9DZs|Benabens/);
});

test("facture PDF en anglais : libellés traduits, mention fiscale française gardée", async () => {
  const { orderFromInvoice } = await import("../lib/billing/orders");
  const { invoicePdf, invoiceSeller } = await import("../lib/billing/invoice-pdf");
  const seller = invoiceSeller(SELLER_ENV);
  assert.ok(seller.ok);
  const text = await pdfText(invoicePdf(orderFromInvoice(fakeInvoice(), { kind: "pack" }), seller.seller, "en"));
  for (const want of ["Invoice", "10-credit pack", "€6.30", "TVA non applicable, art. 293 B du CGI", "VAT not applicable"]) assert.ok(text.includes(want), `« ${want} » absent de : ${text}`);
});

// ─────────────── Mon compte : paiements et factures du compte, jamais ceux d'un autre ───────────────

test("factures du compte : liste des paiements encaissés, PDF pour le propriétaire seulement, refus sans vendeur", async () => {
  const { authRun } = await import("../db/auth-store");
  const { accountInvoices, accountInvoicePdf } = await import("../lib/billing/invoices");
  await user("inv-a", "fr");
  await user("inv-b", "en");
  const pay = (src: string, uid: string, kind: string, cents: number, at: string) => authRun(
    `INSERT INTO stripe_payments (source_id, kind, user_id, currency, amount_cents, livemode, paid_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    src, kind, uid, "eur", cents, 0, at, at,
  );
  await pay("cs_inv1", "inv-a", "pack", 630, "2026-11-01 10:00:00");
  await pay("in_inv2", "inv-a", "subscription", 1490, "2026-11-10 10:00:00");
  await pay("cs_inv3", "inv-b", "pack", 900, "2026-11-05 10:00:00");

  assert.deepEqual((await accountInvoices("inv-a")).map((p) => [p.id, p.kind, p.amountCents]), [["in_inv2", "subscription", 1490], ["cs_inv1", "pack", 630]]);

  const stripe = fakeStripe({ in_cs_inv1: fakeInvoice({ id: "in_cs_inv1" }) }, { cs_inv1: "in_cs_inv1", cs_inv3: "in_other" });
  const ok = await accountInvoicePdf({ userId: "inv-a", id: "cs_inv1", locale: "fr", stripe, env: SELLER_ENV });
  assert.equal(ok.state, "ok");
  if (ok.state === "ok") {
    assert.equal(ok.filename, "facture-cortex-B3A1C2D4-0042.pdf");
    assert.match(await pdfText(ok.pdf), /Camille Durand EI/);
  }
  assert.equal((await accountInvoicePdf({ userId: "inv-a", id: "cs_inv3", locale: "fr", stripe, env: SELLER_ENV })).state, "not_found", "paiement d'un autre compte");
  assert.equal((await accountInvoicePdf({ userId: "inv-a", id: "cs_nope", locale: "fr", stripe, env: SELLER_ENV })).state, "not_found");
  assert.equal((await accountInvoicePdf({ userId: "inv-a", id: "cs_inv1", locale: "fr", stripe, env: {} })).state, "unavailable", "vendeur non configuré");
});
