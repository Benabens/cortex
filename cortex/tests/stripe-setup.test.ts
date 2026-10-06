/**
 * MISE EN PLACE DE STRIPE (scripts/golive-ben.sh → scripts/stripe-live-setup.ts).
 * Le script crée ou retrouve ce dont l'app a besoin dans le compte Stripe :
 * les deux produits, les trois prix par lookup_key, la configuration du portail
 * client propre à Cortex, et le webhook vers l'URL publique. Il est relançable :
 * une seconde exécution ne crée ni ne modifie rien. Un essai à blanc n'écrit
 * jamais. Le compte pouvant servir d'autres applications, rien de ce qui ne
 * porte pas Cortex n'est touché.
 * Seam : setupStripe(client, options) avec un faux client en mémoire — aucun
 * réseau, aucune clé.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type Stripe from "stripe";
import { HANDLED_EVENTS } from "../lib/billing/stripe-events";
import { STRIPE_API_VERSION } from "../lib/billing/stripe-client";
import { findPortalConfiguration, setupStripe, type SetupOptions } from "../lib/billing/stripe-setup";

type Row = Record<string, unknown> & { id: string };
/** Faux compte Stripe : quatre collections en mémoire et le journal des écritures. */
function fakeStripe(seed: { prices?: Row[]; products?: Row[]; portals?: Row[]; webhooks?: Row[] } = {}) {
  const db = { prices: [...(seed.prices ?? [])], products: [...(seed.products ?? [])], portals: [...(seed.portals ?? [])], webhooks: [...(seed.webhooks ?? [])] };
  const writes: string[] = [];
  let n = 0;
  const id = (prefix: string) => `${prefix}_${++n}`;
  const missing = () => Object.assign(new Error("No such resource"), { code: "resource_missing", statusCode: 404 });
  const patch = (rows: Row[], rowId: string, params: Record<string, unknown>) => {
    const row = rows.find((r) => r.id === rowId);
    if (!row) throw missing();
    Object.assign(row, params);
    return row;
  };
  const client = {
    prices: {
      list: async (p: { lookup_keys?: string[]; active?: boolean }) => ({
        data: db.prices.filter((r) => (!p.lookup_keys || p.lookup_keys.includes(String(r.lookup_key))) && (p.active === undefined || r.active === p.active)),
      }),
      create: async (p: Record<string, unknown>) => { writes.push(`prices.create ${p.lookup_key}`); const row = { id: id("price"), active: true, ...p }; db.prices.push(row); return row; },
    },
    products: {
      retrieve: async (productId: string) => { const row = db.products.find((r) => r.id === productId); if (!row) throw missing(); return row; },
      create: async (p: Record<string, unknown>) => { writes.push(`products.create ${p.id}`); const row = { active: true, metadata: {}, ...p } as unknown as Row; db.products.push(row); return row; },
      update: async (productId: string, p: Record<string, unknown>) => { writes.push(`products.update ${productId}`); return patch(db.products, productId, p); },
    },
    billingPortal: {
      configurations: {
        list: async () => ({ data: db.portals }),
        create: async (p: Record<string, unknown>) => { writes.push("portal.create"); const row = { id: id("bpc"), active: true, is_default: false, ...p }; db.portals.push(row); return row; },
        update: async (configId: string, p: Record<string, unknown>) => { writes.push(`portal.update ${configId}`); return patch(db.portals, configId, p); },
      },
    },
    webhookEndpoints: {
      list: async () => ({ data: db.webhooks }),
      create: async (p: Record<string, unknown>) => { writes.push(`webhooks.create ${p.url}`); const row = { id: id("we"), status: "enabled", secret: "whsec_fake_generated", ...p }; db.webhooks.push(row); return row; },
      update: async (endpointId: string, p: Record<string, unknown>) => {
        writes.push(`webhooks.update ${endpointId}`);
        const { disabled, ...rest } = p;
        return patch(db.webhooks, endpointId, { ...rest, ...(disabled === undefined ? {} : { status: disabled ? "disabled" : "enabled" }) });
      },
      del: async (endpointId: string) => { writes.push(`webhooks.del ${endpointId}`); db.webhooks.splice(db.webhooks.findIndex((r) => r.id === endpointId), 1); return { id: endpointId, deleted: true }; },
    },
  };
  return { client: client as unknown as Stripe, db, writes };
}

const OPTIONS: SetupOptions = {
  site: "https://app.cortexexam.com",
  landing: "https://cortexexam.com",
  legacyHosts: ["cortex-app-production-6a65.up.railway.app"],
  dryRun: false,
  rotateWebhook: false,
  apiVersion: STRIPE_API_VERSION,
};
const TARGET = "https://app.cortexexam.com/api/billing/webhook";

test("compte vide : produits, prix, portail et webhook sont créés, et le secret du webhook est rendu une seule fois", async () => {
  const { client, db, writes } = fakeStripe();
  const report = await setupStripe(client, OPTIONS);

  const byKey = Object.fromEntries(db.prices.map((p) => [String(p.lookup_key), p]));
  assert.deepEqual(Object.keys(byKey).sort(), ["cortex_credits_10", "cortex_pro_monthly", "cortex_pro_yearly"]);
  assert.deepEqual([byKey.cortex_pro_monthly.unit_amount, byKey.cortex_pro_monthly.currency, byKey.cortex_pro_monthly.recurring], [1490, "eur", { interval: "month" }]);
  assert.deepEqual([byKey.cortex_pro_yearly.unit_amount, byKey.cortex_pro_yearly.recurring], [11900, { interval: "year" }]);
  assert.deepEqual([byKey.cortex_credits_10.unit_amount, byKey.cortex_credits_10.recurring], [900, undefined], "le pack est un paiement unique");
  assert.equal(byKey.cortex_pro_monthly.product, byKey.cortex_pro_yearly.product, "les deux prix Pro partagent un produit");
  assert.notEqual(byKey.cortex_credits_10.product, byKey.cortex_pro_monthly.product);
  assert.equal(db.products.length, 2);

  const portal = db.portals[0] as unknown as Stripe.BillingPortal.Configuration;
  assert.equal(portal.metadata?.app, "cortex");
  assert.equal(portal.features.subscription_cancel.enabled, true);
  assert.equal(portal.features.subscription_cancel.mode, "at_period_end", "résiliation à la fin de la période payée");
  assert.equal(portal.features.subscription_update.enabled, false, "pas de changement d'offre : sa facture au prorata n'ouvre pas une période entière");
  assert.equal(portal.default_return_url, "https://app.cortexexam.com/compte");
  assert.equal(portal.business_profile.terms_of_service_url, "https://cortexexam.com/terms");

  const hook = db.webhooks[0];
  assert.equal(hook.url, TARGET);
  assert.deepEqual([...(hook.enabled_events as string[])].sort(), [...HANDLED_EVENTS].sort());
  assert.equal(hook.api_version, STRIPE_API_VERSION, "les événements arrivent dans le format que le code lit");
  assert.equal(report.webhookSecret, "whsec_fake_generated");
  assert.ok(writes.length > 0);
  assert.ok(!JSON.stringify(report.steps).includes("whsec_"), "le secret n'apparaît dans aucune ligne du compte rendu");
});

test("relancé sur un compte déjà en place : aucune écriture, aucun secret (il n'est lisible qu'à la création)", async () => {
  const { client, writes } = fakeStripe();
  await setupStripe(client, OPTIONS);
  writes.length = 0;
  const again = await setupStripe(client, OPTIONS);
  assert.deepEqual(writes, []);
  assert.equal(again.webhookSecret, null);
  assert.ok(again.steps.every((s) => s.action === "inchangé"), JSON.stringify(again.steps));
});

test("essai à blanc : rien n'est écrit, le compte rendu dit ce qui serait fait", async () => {
  const { client, db, writes } = fakeStripe();
  const report = await setupStripe(client, { ...OPTIONS, dryRun: true });
  assert.deepEqual(writes, []);
  assert.deepEqual([db.prices.length, db.products.length, db.portals.length, db.webhooks.length], [0, 0, 0, 0]);
  assert.equal(report.webhookSecret, null);
  assert.ok(report.steps.some((s) => s.what === "webhook" && s.action === "à créer"));
  assert.ok(report.steps.filter((s) => s.what === "prix" && s.action === "à créer").length === 3);
});

test("prix déjà présent mais à un autre montant : signalé, jamais modifié (c'est de l'argent, la décision n'est pas au script)", async () => {
  const { client, db, writes } = fakeStripe({
    products: [{ id: "prod_x", name: "Cortex Pro", active: true, metadata: {} }],
    prices: [{ id: "price_old", lookup_key: "cortex_pro_monthly", active: true, unit_amount: 1200, currency: "eur", recurring: { interval: "month", interval_count: 1 }, product: "prod_x" }],
  });
  const report = await setupStripe(client, OPTIONS);
  const drift = report.steps.find((s) => s.what === "prix" && s.action === "attention");
  assert.ok(drift, "l'écart est signalé");
  assert.match(drift!.detail, /12,00|1200/);
  assert.equal(db.prices.find((p) => p.id === "price_old")?.unit_amount, 1200);
  assert.ok(!writes.includes("prices.create cortex_pro_monthly"));
  assert.equal(db.prices.find((p) => p.lookup_key === "cortex_pro_yearly")?.product, "prod_x", "le prix manquant rejoint le produit existant");
});

test("ancien webhook de Cortex (ancienne adresse) : désactivé une fois le nouveau en place ; ceux des autres applications ne bougent pas", async () => {
  const { client, db } = fakeStripe({
    webhooks: [
      { id: "we_old", url: "https://cortex-app-production-6a65.up.railway.app/api/billing/webhook", status: "enabled", enabled_events: [...HANDLED_EVENTS], api_version: STRIPE_API_VERSION },
      { id: "we_kairo", url: "https://kairocareer.app/api/billing/webhook", status: "enabled", enabled_events: ["invoice.paid"], api_version: STRIPE_API_VERSION },
    ],
    portals: [{ id: "bpc_kairo", active: true, metadata: { app: "kairo" }, features: { subscription_update: { enabled: true } } }],
  });
  const report = await setupStripe(client, OPTIONS);
  assert.equal(db.webhooks.find((w) => w.id === "we_old")?.status, "disabled", "sinon chaque événement arriverait deux fois, dont une avec l'ancien secret");
  assert.equal(db.webhooks.find((w) => w.id === "we_kairo")?.status, "enabled");
  assert.ok(db.webhooks.some((w) => w.url === TARGET && w.status === "enabled"));
  assert.ok(report.steps.some((s) => s.what === "ancien webhook" && s.action === "désactivé"));
  const kairo = db.portals.find((p) => p.id === "bpc_kairo") as unknown as Stripe.BillingPortal.Configuration;
  assert.equal(kairo.features.subscription_update.enabled, true, "la configuration de portail d'une autre application n'est pas touchée");
  assert.equal(await findPortalConfiguration(client), db.portals.find((p) => (p.metadata as Record<string, string>).app === "cortex")?.id);
});

test("webhook existant dont les événements ont dérivé : recalé, sans nouveau secret ; --rotate-webhook le recrée", async () => {
  const { client, db, writes } = fakeStripe({
    webhooks: [{ id: "we_cur", url: TARGET, status: "enabled", enabled_events: ["invoice.paid"], api_version: STRIPE_API_VERSION }],
  });
  const report = await setupStripe(client, OPTIONS);
  assert.deepEqual([...(db.webhooks[0].enabled_events as string[])].sort(), [...HANDLED_EVENTS].sort());
  assert.equal(report.webhookSecret, null);
  writes.length = 0;
  const rotated = await setupStripe(client, { ...OPTIONS, rotateWebhook: true });
  assert.ok(writes.includes("webhooks.del we_cur"));
  assert.equal(rotated.webhookSecret, "whsec_fake_generated");
  assert.equal(db.webhooks.filter((w) => w.url === TARGET).length, 1);
});

test("portail : sans configuration propre à Cortex, l'app laisse Stripe prendre celle du compte", async () => {
  const { client } = fakeStripe({ portals: [{ id: "bpc_kairo", active: true, metadata: { app: "kairo" } }, { id: "bpc_off", active: false, metadata: { app: "cortex" } }] });
  assert.equal(await findPortalConfiguration(client), null);
});

test("adresse refusée : le webhook live ne vise jamais une adresse locale ou sans https", async () => {
  const { client } = fakeStripe();
  await assert.rejects(setupStripe(client, { ...OPTIONS, site: "http://localhost:3000" }), /https/);
  await assert.rejects(setupStripe(client, { ...OPTIONS, site: "https://app.cortexexam.com/" }), /barre finale|invalide/);
});

test("les événements écoutés sont exactement ceux que le webhook traite", () => {
  assert.deepEqual([...HANDLED_EVENTS].sort(), [
    "charge.dispute.created", "charge.refunded", "checkout.session.async_payment_succeeded", "checkout.session.completed",
    "customer.subscription.deleted", "customer.subscription.updated", "invoice.paid",
  ]);
});

test("clé de l'app : ses droits sont vérifiés (lectures seules) avant d'être posée en production", async () => {
  const { missingRuntimeAccess } = await import("../lib/billing/stripe-setup");
  const { client } = fakeStripe();
  const forbidden = () => Promise.reject(Object.assign(new Error("The provided key does not have the required permissions"), { type: "StripePermissionError", statusCode: 403 }));
  const allowed = async () => ({ data: [] });
  const withAccess = (over: Record<string, unknown>) => ({
    ...client,
    checkout: { sessions: { list: allowed } },
    subscriptions: { list: allowed },
    invoices: { list: allowed },
    ...over,
  }) as unknown as Stripe;

  assert.deepEqual(await missingRuntimeAccess(withAccess({})), [], "clé complète : rien ne manque");
  // Clé de MISE EN PLACE réutilisée comme clé de l'app : elle n'ouvre ni le paiement ni les abonnements.
  assert.deepEqual(
    await missingRuntimeAccess(withAccess({ checkout: { sessions: { list: forbidden } }, subscriptions: { list: forbidden } })),
    ["Checkout Sessions", "Subscriptions"],
  );
  // Une panne n'est pas un droit manquant : elle remonte telle quelle.
  await assert.rejects(missingRuntimeAccess(withAccess({ invoices: { list: () => Promise.reject(new Error("réseau coupé")) } })), /réseau coupé/);
});
