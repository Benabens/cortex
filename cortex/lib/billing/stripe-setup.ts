/**
 * MISE EN PLACE DE STRIPE pour Cortex : produits, prix par lookup_key, portail
 * client, webhook. Lancée par scripts/golive-ben.sh (via
 * scripts/stripe-live-setup.ts), jamais par l'app. Aucune clé ne passe ici : le
 * client Stripe est fourni par l'appelant, et le mode (test ou live) est celui
 * de sa clé.
 *
 * IDEMPOTENTE : relancée, elle ne crée ni ne modifie rien. Elle RETROUVE ce qui
 * existe (les prix par leur lookup_key, la configuration de portail par son
 * étiquette, le webhook par son URL) et ne crée que ce qui manque.
 *
 * COMPTE PARTAGÉ : le compte Stripe peut servir d'autres applications. On ne
 * touche qu'à ce qui porte Cortex — lookup_keys `cortex_*`, configuration de
 * portail étiquetée `app=cortex`, webhooks dont l'URL est celle de Cortex.
 *
 * Un prix existant dont le montant diffère est SIGNALÉ, jamais modifié : c'est
 * de l'argent, la décision n'appartient pas à un script.
 */
import type Stripe from "stripe";
import { HANDLED_EVENTS, PLANS } from "./stripe-events";

/** Étiquette de la configuration de portail de Cortex (metadata.app). */
export const PORTAL_APP_TAG = "cortex";
export const WEBHOOK_PATH = "/api/billing/webhook";

type ProductKey = "pro" | "pack";
const PRODUCTS: Record<ProductKey, { id: string; name: string; description: string; statement_descriptor?: string }> = {
  // Le libellé de relevé d'un abonnement est celui de son produit (un pack reçoit le sien au paiement : checkout-params).
  pro: { id: "cortex_pro", name: "Cortex Pro", description: "Abonnement Cortex Pro : 20 crédits de génération par mois.", statement_descriptor: "BENABENS CORTEX" },
  pack: { id: "cortex_credits_10", name: "Cortex : pack de 10 crédits", description: "10 crédits de génération, sans date d'expiration." },
};

/** Les trois prix de l'offre, en centimes d'euro. Les lookup_keys sont celles que lit l'app (PLANS). */
export const OFFERS: ReadonlyArray<{ lookupKey: string; product: ProductKey; unitAmount: number; interval: "month" | "year" | null; nickname: string }> = [
  { lookupKey: PLANS.pro_monthly.lookupKey, product: "pro", unitAmount: 1490, interval: "month", nickname: "Pro mensuel 14,90 €" },
  { lookupKey: PLANS.pro_yearly.lookupKey, product: "pro", unitAmount: 11900, interval: "year", nickname: "Pro annuel 119 €" },
  { lookupKey: PLANS.credits_10.lookupKey, product: "pack", unitAmount: 900, interval: null, nickname: "Pack de 10 crédits 9 €" },
];

export interface SetupOptions {
  /** Adresse publique de l'app, sans barre finale (https://app.cortexexam.com) : cible du webhook, retour du portail. */
  site: string;
  /** Adresse de la vitrine, sans barre finale : conditions et confidentialité affichées par le portail. */
  landing: string;
  /** Anciens hôtes de l'app : un webhook Cortex encore actif dessus est désactivé une fois le nouveau en place. */
  legacyHosts: string[];
  /** Lectures seules : dit ce qui serait fait. */
  dryRun: boolean;
  /** Supprime et recrée le webhook : seule façon d'obtenir un nouveau secret de signature. */
  rotateWebhook: boolean;
  /** Version d'API épinglée sur le webhook : celle dont le code lit la forme des événements. */
  apiVersion: string;
}

export interface SetupStep {
  what: "produit" | "prix" | "portail" | "webhook" | "ancien webhook";
  action: "créé" | "mis à jour" | "inchangé" | "désactivé" | "à créer" | "à mettre à jour" | "à désactiver" | "attention";
  detail: string;
}

export interface SetupReport {
  steps: SetupStep[];
  /** Secret de signature, seulement quand le webhook vient d'être créé (Stripe ne le redonne jamais). Jamais affiché. */
  webhookSecret: string | null;
}

export function portalParams(site: string, landing: string) {
  return {
    business_profile: {
      headline: "Cortex : carte, factures, résiliation",
      privacy_policy_url: `${landing}/privacy`,
      terms_of_service_url: `${landing}/terms`,
    },
    default_return_url: `${site}/compte`,
    features: {
      customer_update: { enabled: false },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      // Résiliation en ligne, effet à la fin de la période payée.
      subscription_cancel: { enabled: true, mode: "at_period_end" as const },
      // Pas de changement d'offre : sa facture au prorata n'ouvre pas une période entière côté app.
      subscription_update: { enabled: false },
    },
    metadata: { app: PORTAL_APP_TAG },
  };
}

const euros = (cents: number | null | undefined) => `${((cents ?? 0) / 100).toFixed(2).replace(".", ",")} €`;
const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : v?.id ?? null);

function isMissing(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number };
  return e?.code === "resource_missing" || e?.statusCode === 404;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

function priceMatches(p: Stripe.Price, offer: (typeof OFFERS)[number]): boolean {
  if (p.unit_amount !== offer.unitAmount || p.currency !== "eur") return false;
  if (!offer.interval) return !p.recurring;
  return p.recurring?.interval === offer.interval && (p.recurring.interval_count ?? 1) === 1;
}

/** La configuration en place dit-elle déjà ce qu'on veut ? (seuls les champs que l'on pose sont comparés) */
function portalMatches(c: Stripe.BillingPortal.Configuration, want: ReturnType<typeof portalParams>): boolean {
  const f = c.features;
  return (
    c.default_return_url === want.default_return_url &&
    c.business_profile?.headline === want.business_profile.headline &&
    c.business_profile?.privacy_policy_url === want.business_profile.privacy_policy_url &&
    c.business_profile?.terms_of_service_url === want.business_profile.terms_of_service_url &&
    f?.customer_update?.enabled === false &&
    f?.invoice_history?.enabled === true &&
    f?.payment_method_update?.enabled === true &&
    f?.subscription_cancel?.enabled === true &&
    f?.subscription_cancel?.mode === "at_period_end" &&
    f?.subscription_update?.enabled === false
  );
}

function assertOrigin(name: string, value: string): void {
  if (!/^https:\/\/[^/]+$/.test(value)) throw new Error(`Adresse ${name} invalide : « ${value} » (attendu https://domaine, sans barre finale).`);
}

export async function setupStripe(s: Stripe, o: SetupOptions): Promise<SetupReport> {
  assertOrigin("du site", o.site);
  assertOrigin("de la vitrine", o.landing);
  const steps: SetupStep[] = [];
  const say = (what: SetupStep["what"], done: SetupStep["action"], planned: SetupStep["action"], detail: string) =>
    steps.push({ what, action: o.dryRun ? planned : done, detail });

  // --- Prix existants (par lookup_key) -------------------------------------------
  const existing = new Map<string, Stripe.Price>();
  for (const offer of OFFERS) {
    const found = (await s.prices.list({ lookup_keys: [offer.lookupKey], active: true, limit: 1 })).data[0];
    if (found) existing.set(offer.lookupKey, found);
  }

  // --- Produits : celui d'un prix existant, sinon l'identifiant fixe --------------
  const productIds: Partial<Record<ProductKey, string>> = {};
  for (const key of Object.keys(PRODUCTS) as ProductKey[]) {
    const spec = PRODUCTS[key];
    const viaPrice = OFFERS.filter((f) => f.product === key).map((f) => idOf(existing.get(f.lookupKey)?.product)).find(Boolean);
    let product: Stripe.Product | null = null;
    try {
      const found = await s.products.retrieve(viaPrice ?? spec.id);
      product = "deleted" in found && found.deleted ? null : (found as Stripe.Product);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    if (!product) {
      if (!o.dryRun) product = await s.products.create({ id: spec.id, name: spec.name, description: spec.description, url: o.landing, metadata: { app: PORTAL_APP_TAG }, ...(spec.statement_descriptor ? { statement_descriptor: spec.statement_descriptor } : {}) });
      say("produit", "créé", "à créer", `${spec.id} « ${spec.name} »`);
    } else if (!product.active || (spec.statement_descriptor && !product.statement_descriptor)) {
      if (!o.dryRun) await s.products.update(product.id, { active: true, ...(spec.statement_descriptor ? { statement_descriptor: spec.statement_descriptor } : {}) });
      say("produit", "mis à jour", "à mettre à jour", `${product.id} « ${product.name} » (actif${spec.statement_descriptor ? `, libellé de relevé ${spec.statement_descriptor}` : ""})`);
    } else {
      steps.push({ what: "produit", action: "inchangé", detail: `${product.id} « ${product.name} »` });
    }
    productIds[key] = product?.id ?? spec.id;
  }

  // --- Prix : créés s'ils manquent, signalés s'ils diffèrent ----------------------
  for (const offer of OFFERS) {
    const wanted = `${euros(offer.unitAmount)}${offer.interval === "month" ? " / mois" : offer.interval === "year" ? " / an" : ""}, lookup_key ${offer.lookupKey}`;
    const current = existing.get(offer.lookupKey);
    if (current && priceMatches(current, offer)) {
      steps.push({ what: "prix", action: "inchangé", detail: `${current.id} (${wanted})` });
    } else if (current) {
      const got = `${euros(current.unit_amount)}${current.recurring ? ` / ${current.recurring.interval}` : ""} en ${current.currency}`;
      steps.push({ what: "prix", action: "attention", detail: `${current.id} porte ${offer.lookupKey} à ${got}, attendu ${wanted} : laissé tel quel, à trancher dans le tableau de bord` });
    } else {
      let created: Stripe.Price | null = null;
      if (!o.dryRun) {
        created = await s.prices.create({
          product: productIds[offer.product]!,
          currency: "eur",
          unit_amount: offer.unitAmount,
          ...(offer.interval ? { recurring: { interval: offer.interval } } : {}),
          lookup_key: offer.lookupKey,
          // Une lookup_key peut rester accrochée à un prix archivé : on la reprend.
          transfer_lookup_key: true,
          nickname: offer.nickname,
        });
      }
      say("prix", "créé", "à créer", `${created?.id ?? "nouveau prix"} (${wanted})`);
    }
  }

  // --- Portail client : configuration propre à Cortex ------------------------------
  const want = portalParams(o.site, o.landing);
  const portal = (await s.billingPortal.configurations.list({ limit: 100 })).data.find((c) => c.active && c.metadata?.app === PORTAL_APP_TAG) ?? null;
  if (portal && portalMatches(portal, want)) {
    steps.push({ what: "portail", action: "inchangé", detail: `${portal.id} (résiliation en fin de période, pas de changement d'offre)` });
  } else {
    if (!o.dryRun) {
      if (portal) await s.billingPortal.configurations.update(portal.id, want);
      else await s.billingPortal.configurations.create(want);
    }
    say("portail", portal ? "mis à jour" : "créé", portal ? "à mettre à jour" : "à créer", `${portal?.id ?? "configuration"} étiquetée app=${PORTAL_APP_TAG} (résiliation en fin de période, pas de changement d'offre)`);
  }

  // --- Webhook --------------------------------------------------------------------
  const url = `${o.site}${WEBHOOK_PATH}`;
  const events = [...HANDLED_EVENTS] as Stripe.WebhookEndpointCreateParams.EnabledEvent[];
  const endpoints = (await s.webhookEndpoints.list({ limit: 100 })).data;
  let endpoint = endpoints.find((w) => w.url === url) ?? null;
  let webhookSecret: string | null = null;
  if (endpoint && o.rotateWebhook) {
    if (!o.dryRun) await s.webhookEndpoints.del(endpoint.id);
    say("webhook", "désactivé", "à désactiver", `${endpoint.id} supprimé (nouveau secret de signature)`);
    endpoint = null;
  }
  if (!endpoint) {
    if (!o.dryRun) {
      const made = await s.webhookEndpoints.create({
        url,
        enabled_events: events,
        api_version: o.apiVersion as Stripe.WebhookEndpointCreateParams.ApiVersion,
        description: "Cortex : crédits et abonnements",
      });
      webhookSecret = made.secret ?? null;
    }
    say("webhook", "créé", "à créer", `${url} (${events.length} événements, API ${o.apiVersion})`);
  } else {
    if (endpoint.status !== "enabled" || !sameSet(endpoint.enabled_events, events)) {
      if (!o.dryRun) await s.webhookEndpoints.update(endpoint.id, { enabled_events: events, disabled: false });
      say("webhook", "mis à jour", "à mettre à jour", `${endpoint.id} (événements recalés, endpoint actif) : secret de signature inchangé`);
    } else {
      steps.push({ what: "webhook", action: "inchangé", detail: `${endpoint.id} → ${url} : secret de signature inchangé` });
    }
    if (endpoint.api_version !== o.apiVersion) {
      steps.push({ what: "webhook", action: "attention", detail: `${endpoint.id} est en API ${endpoint.api_version ?? "par défaut du compte"}, le code épingle ${o.apiVersion} (il lit les deux formats) : --rotate-webhook pour l'aligner` });
    }
  }

  // --- Anciens webhooks de Cortex : sans cela chaque événement arriverait deux fois,
  //     dont une signée avec un secret que l'app n'a plus. Désactivés, pas supprimés.
  for (const old of endpoints) {
    let at: URL;
    try { at = new URL(old.url); } catch { continue; }
    if (old.url === url || old.status !== "enabled" || at.pathname !== WEBHOOK_PATH || !o.legacyHosts.includes(at.hostname)) continue;
    if (!o.dryRun) await s.webhookEndpoints.update(old.id, { disabled: true });
    say("ancien webhook", "désactivé", "à désactiver", `${old.id} → ${old.url}`);
  }

  return { steps, webhookSecret };
}

/** Configuration de portail de Cortex, ou null (Stripe prend alors celle par défaut du compte). */
export async function findPortalConfiguration(s: Stripe): Promise<string | null> {
  const list = await s.billingPortal.configurations.list({ active: true, limit: 100 });
  return list.data.find((c) => c.active && c.metadata?.app === PORTAL_APP_TAG)?.id ?? null;
}
