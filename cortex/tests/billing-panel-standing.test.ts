/**
 * Page « Abonnement & crédits » — ce que lit un abonné dont l'abonnement n'est
 * PAS dans son état nominal : renouvellement en cours d'encaissement, paiement
 * en échec, suspension après remboursement, résiliation programmée. Dans chacun
 * de ces états l'écran dit ce qui se passe et quoi faire, et ne propose jamais
 * d'ouvrir un second abonnement. Vue pure (BillingView), rendue sans navigateur.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type Props = import("../app/compte/BillingPanel").BillingViewProps;
type Sub = NonNullable<Props["data"]["subscription"]>;
const noop = () => {};
const sub = (over: Partial<Sub>): Sub => ({
  status: "active", standing: "live", live: true, plan: "cortex_pro_monthly", creditsThisMonth: 17, monthlyCredits: 20,
  periodEnd: "2026-10-28 10:00:00", nextRechargeAt: "2026-10-28", cancelsAtPeriodEnd: false, manageable: true,
  ...over,
});
const data = (subscription: Sub): Props["data"] => ({
  billing: true,
  purchase: { enabled: true, reason: null },
  legal: { terms: "https://x/cgv", privacy: "https://x/priv", refund: "https://x/remb", notice: "https://x/mentions" },
  terms: { version: "2026-09", accepted: true, acceptedAt: "2026-09-26 10:00:00", withdrawalAccepted: true, withdrawalAcceptedAt: "2026-09-26 10:00:00" },
  balance: 10,
  purchased: 10,
  subscription,
  costs: { exam: 2, qcm: 1, exercise: 1, assist: 0.1 },
  transactions: [],
  offers: [
    { plan: "pro_monthly", kind: "subscription", label: "Pro — mensuel", credits: 20, interval: "month", price: { amount: 14.9, currency: "EUR" } },
    { plan: "pro_yearly", kind: "subscription", label: "Pro — annuel", credits: 20, interval: "year", price: { amount: 119, currency: "EUR" } },
    { plan: "credits_10", kind: "pack", label: "Pack de 10 crédits", credits: 10, interval: null, price: { amount: 9, currency: "EUR" } },
  ],
});
async function render(subscription: Sub): Promise<string> {
  const { BillingView } = await import("../app/compte/BillingPanel");
  return renderToStaticMarkup(createElement(BillingView, { data: data(subscription), busy: null, actionError: null, retour: null, onRefresh: noop, onAcceptTerms: noop, onCheckout: noop, onPortal: noop }));
}
/** Boutons « S’abonner » (balise ouvrante) : désactivés tant qu'un abonnement existe chez Stripe. */
const subscribeButtons = (html: string) => [...html.matchAll(/<button[^>]*>(?:(?!<\/button>).)*S’abonner/g)].map((m) => m[0]);
const isDisabled = (tag: string) => /\sdisabled(?:=""|(?=[\s>]))/.test(tag);
const noSecondSubscription = (html: string) => {
  const subs = subscribeButtons(html);
  assert.equal(subs.length, 2);
  assert.ok(subs.every(isDisabled), "aucun second abonnement proposé");
};

test("renouvellement en cours d'encaissement : l'écran le dit, sans alarmer ni proposer de se réabonner", async () => {
  const html = await render(sub({ standing: "renewing", live: false, creditsThisMonth: 0, nextRechargeAt: null }));
  assert.match(html, /renouvellement en cours/);
  assert.match(html, /dès que le paiement est confirmé/);
  assert.ok(!/Aucun abonnement/.test(html));
  noSecondSubscription(html);
});

test("paiement en échec : aucun crédit d'abonnement, la marche à suivre et le bouton Gérer ; les crédits achetés restent", async () => {
  const html = await render(sub({ status: "past_due", standing: "unpaid", live: false, creditsThisMonth: 0, nextRechargeAt: null }));
  assert.match(html, /paiement en échec/);
  assert.match(html, /moyen de paiement/);
  assert.match(html, /Gérer mon abonnement/);
  assert.match(html, /crédits achetés restent utilisables/);
  assert.ok(!/17 \/ 20/.test(html), "pas de crédits du mois affichés pour un abonnement impayé");
  noSecondSubscription(html);
});

test("suspendu après un remboursement ou un litige : l'écran explique la reprise", async () => {
  const html = await render(sub({ standing: "suspended", live: false, creditsThisMonth: 0, nextRechargeAt: null }));
  assert.match(html, /suspendu/);
  assert.match(html, /prochaine facture payée/);
  noSecondSubscription(html);
});

test("résiliation programmée : actif jusqu'à la fin de la période payée, plus de « recharge le »", async () => {
  const html = await render(sub({ cancelsAtPeriodEnd: true, nextRechargeAt: null }));
  assert.match(html, /résiliation programmée/);
  assert.match(html, /17 \/ 20/);
  assert.match(html, /se termine le 28 octobre 2026/);
  assert.ok(!/recharge le/.test(html));
  noSecondSubscription(html);
});

test("abonnement terminé : « Aucun abonnement », réabonnement possible, factures toujours accessibles", async () => {
  const html = await render(sub({ status: "canceled", standing: "none", live: false, creditsThisMonth: 0, nextRechargeAt: null }));
  assert.match(html, /Aucun abonnement/);
  assert.match(html, /Gérer mon abonnement/);
  assert.ok(!/tu as déjà un abonnement/.test(html), "les offres d'abonnement sont de nouveau ouvertes");
});
