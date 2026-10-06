/**
 * Page « Abonnement & crédits » — la vue est PURE (BillingView) : on la rend
 * côté serveur état par état et on vérifie ce que l'utilisateur lit, sans
 * navigateur : facturation coupée, compte sans abonnement, abonnement actif
 * avec recharge, solde négatif après reprise, CGV non acceptées (achat
 * bloqué), achats fermés (raison affichée), retour Stripe.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type Props = import("../app/compte/BillingPanel").BillingViewProps;
const noop = () => {};
const base = (over: Partial<Props["data"]> = {}): Props["data"] => ({
  billing: true,
  purchase: { enabled: true, reason: null },
  legal: { terms: "https://x/cgv", privacy: "https://x/priv", refund: "https://x/remb", notice: "https://x/mentions" },
  terms: { version: "2026-09", accepted: true, acceptedAt: "2026-09-26 10:00:00", withdrawalAccepted: true, withdrawalAcceptedAt: "2026-09-26 10:00:00" },
  balance: 12,
  purchased: 12,
  subscription: null,
  costs: { exam: 2, qcm: 1, exercise: 1, assist: 0.1 },
  transactions: [
    { delta: 10, subAmount: 0, reason: "achat credits_10", ref: "stripe:cs:1", created_at: "2026-09-20 10:00:00" },
    { delta: 0, subAmount: 2, reason: "génération exam", ref: "job:a:ml:1", created_at: "2026-09-21 10:00:00" },
  ],
  offers: [
    { plan: "pro_monthly", kind: "subscription", label: "Pro — mensuel", credits: 20, interval: "month", price: { amount: 14.9, currency: "EUR" } },
    { plan: "pro_yearly", kind: "subscription", label: "Pro — annuel", credits: 20, interval: "year", price: { amount: 119, currency: "EUR" } },
    { plan: "credits_10", kind: "pack", label: "Pack de 10 crédits", credits: 10, interval: null, price: { amount: 9, currency: "EUR" } },
  ],
  ...over,
});
async function render(data: Props["data"], extra: Partial<Props> = {}): Promise<string> {
  const { BillingView } = await import("../app/compte/BillingPanel");
  return renderToStaticMarkup(createElement(BillingView, { data, busy: null, actionError: null, retour: null, onRefresh: noop, onAcceptTerms: noop, onCheckout: noop, onPortal: noop, ...extra }));
}
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
/** Attribut HTML `disabled` (pas la classe utilitaire `disabled:` de Tailwind). */
const isDisabled = (tag: string) => /\sdisabled(?:=""|(?=[\s>]))/.test(tag);

test("facturation coupée : un message, aucune offre", async () => {
  const html = await render(base({ billing: false }));
  assert.match(html, /facturation n’est pas activée/);
  assert.ok(!/S’abonner/.test(html));
});

test("compte sans abonnement, CGV acceptées : consentement par offre avant activation, prix et historique", async () => {
  const html = await render(base());
  assert.match(html, /Solde disponible/);
  assert.match(html, /12 crédits/);
  assert.match(html, /Aucun abonnement/);
  // fr-FR : virgule décimale, pas de décimales inutiles, espace insécable avant €.
  assert.match(html, /14,90\u00a0€ \/ mois/);
  assert.ok(!/14\.90|119[.,]00|(?<![0-9])9[.,]00/.test(html), "aucun format anglo-saxon ni décimales inutiles");
  assert.match(html, /119\u00a0€ \/ an/);
  assert.match(html, /(?<![0-9,])9\u00a0€/);
  assert.equal(buttons(html).filter(isDisabled).length, 3, "chaque achat attend son consentement propre");
  assert.match(html, /perdre mon droit de rétractation dès leur première utilisation/);
  assert.match(html, /montant proportionnel au service déjà fourni restera dû/);
  assert.match(html, /acceptées le 26 septembre 2026/);
  assert.match(html, /achat credits_10/);
  assert.match(html, /génération exam/);
  assert.match(html, /Mentions légales/);
});

test("abonnement actif : reste / plafond, date de recharge, bouton Gérer, abonnements non re-souscriptibles", async () => {
  const html = await render(base({
    balance: 27, purchased: 10,
    subscription: { status: "active", standing: "live", live: true, plan: "cortex_pro_monthly", creditsThisMonth: 17, monthlyCredits: 20, periodEnd: "2026-10-26 10:00:00", nextRechargeAt: "2026-10-01", cancelsAtPeriodEnd: false, manageable: true },
  }));
  assert.match(html, /17 \/ 20/);
  assert.match(html, /recharge le 1 octobre 2026/);
  assert.match(html, /Gérer mon abonnement/);
  assert.match(html, /tu as déjà un abonnement/);
  const disabledSub = buttons(html).filter(isDisabled);
  assert.equal(disabledSub.length, 3, "les offres attendent leur consentement et les abonnements restent indisponibles");
});

test("solde négatif après reprise Stripe : avertissement explicite", async () => {
  const html = await render(base({ balance: -4, purchased: -4 }));
  assert.match(html, /Solde négatif/);
  assert.match(html, /-4 crédits|−4 crédits/);
});

test("CGV non acceptées : une case CGV et trois consentements propres aux offres", async () => {
  const html = await render(base({ terms: { version: "2026-09", accepted: false, acceptedAt: null, withdrawalAccepted: false, withdrawalAcceptedAt: null } }));
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 4, "case CGV + consentement de chaque offre");
  assert.match(html, /href="https:\/\/x\/remb"[^>]*>[^<]*[Pp]olitique de remboursement/);
  assert.match(html, /consentements propres à chaque achat/);
  // Les offres restent désactivées ; le bouton de confirmation existe (désactivé tant que les cases ne sont pas cochées).
  const offerButtons = buttons(html).filter((b) => !/Confirmer/.test(b));
  assert.equal(offerButtons.filter(isDisabled).length, 3, "les trois offres sont désactivées");
  assert.ok(buttons(html).some((b) => /Confirmer/.test(b)), "bouton de confirmation présent");
});

test("CGV acceptées : seuls les consentements propres aux trois offres sont demandés", async () => {
  const html = await render(base({ terms: { version: "2026-09", accepted: true, acceptedAt: "2026-09-01 10:00:00", withdrawalAccepted: false, withdrawalAcceptedAt: null } }));
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3);
  assert.match(html, /droit de rétractation/);
  assert.match(html, /acceptées le/);
  assert.equal(buttons(html).filter((b) => !/Confirmer/.test(b)).filter(isDisabled).length, 3, "achats désactivés tant que leur consentement manque");
});

test("achats fermés : la raison est affichée, tout est désactivé", async () => {
  const html = await render(base({ purchase: { enabled: false, reason: "Les achats sont suspendus : les documents légaux ne sont pas publiés." } }));
  assert.match(html, /documents légaux ne sont pas publiés/);
  assert.equal(buttons(html).filter(isDisabled).length, 3);
});

test("retour de Stripe : confirmation ou annulation en clair", async () => {
  assert.match(await render(base(), { retour: "ok" }), /Paiement confirmé/);
  assert.match(await render(base(), { retour: "annule" }), /Rien n’a été débité/);
});

test("revue : hors production sans liens légaux mais achats ouverts (staging), la case CGV reste cochable", async () => {
  const html = await render(base({
    legal: { terms: null, privacy: null, refund: null, notice: null },
    terms: { version: "2026-09", accepted: false, acceptedAt: null, withdrawalAccepted: false, withdrawalAcceptedAt: null },
  }));
  const checkbox = /<input[^>]*type="checkbox"[^>]*>/.exec(html)?.[0] ?? "";
  assert.ok(checkbox, "case présente");
  assert.ok(!/\sdisabled(?:=""|(?=[\s>]))/.test(checkbox), "la case ne doit pas être désactivée quand l'API autorise l'achat");
  assert.match(html, /non publiés|non configurés/i);
});

test("conditions de renouvellement affichées à côté des offres d'abonnement, AVANT tout achat", async () => {
  // Compte neuf : aucune souscription, donc l'ancien bloc « Gérer mon abonnement » (qui portait
  // seule l'information) n'est pas rendu. L'information doit être là quand même.
  const html = await render(base({ subscription: null }));
  assert.match(html, /Renouvellement automatique chaque mois/);
  assert.match(html, /Renouvellement automatique chaque année/);
  assert.match(html, /[Rr]ésiliable à tout moment/);
  assert.match(html, /effet en fin de période/);
  assert.match(html, /Mon compte/);
  // Le pack n'est pas un abonnement : aucune mention de renouvellement sur sa ligne.
  const packRow = /<li[^>]*>(?:(?!<\/li>)[\s\S])*Pack de 10 crédits(?:(?!<\/li>)[\s\S])*<\/li>/.exec(html)?.[0] ?? "";
  assert.ok(packRow, "la ligne du pack est rendue");
  assert.ok(!/[Rr]enouvellement/.test(packRow), "un pack ne se renouvelle pas");
  assert.match(packRow, /sans date d’expiration/);
});
