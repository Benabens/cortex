/**
 * PRÉ-LANCEMENT 7 — deux écritures silencieuses : les suppressions (examen,
 * source) ignoraient le code de réponse, donc un refus 403/500 passait pour un
 * succès et l'interface se rafraîchissait comme si ; et pendant la redirection
 * vers Stripe, les autres offres restaient cliquables (deux paiements possibles).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ── apiDelete : une suppression refusée doit LEVER, avec le message du serveur ──
const withFetch = async <T,>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = original; }
};
const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("apiDelete : 200 → résolu ; refus → erreur portant le message du serveur ; corps illisible → code HTTP", async () => {
  const { apiDelete } = await import("../lib/ux/write");
  const calls: string[] = [];
  await withFetch(async (url) => { calls.push(String(url)); return jsonResponse(200, { ok: true }); },
    () => apiDelete("/api/exams?id=1"));
  assert.deepEqual(calls, ["/api/exams?id=1"]);
  await assert.rejects(
    withFetch(async () => jsonResponse(403, { error: "Cours introuvable." }), () => apiDelete("/api/exams?id=1")),
    /Cours introuvable\./,
  );
  await assert.rejects(
    withFetch(async () => new Response("boom", { status: 500 }), () => apiDelete("/api/sources?path=x")),
    /500/,
  );
});

test("les deux écrans passent par apiDelete (plus de suppression silencieuse)", async () => {
  const fs = await import("node:fs");
  for (const f of ["app/examens/page.tsx", "components/sources/FileManager.tsx"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.match(src, /apiDelete\(/, `${f} : suppression non vérifiée`);
    assert.ok(!/fetch\([^)]*method:\s*"DELETE"/.test(src.replace(/\s+/g, " ")), `${f} : fetch DELETE direct restant`);
  }
});

// ── Offres : aucun second départ vers Stripe pendant une redirection ──
const base = {
  billing: true, stripeConfigured: true, purchase: { enabled: true, reason: null },
  legal: { terms: "https://x/cgv", privacy: "https://x/priv", refund: "https://x/remb", notice: "https://x/mentions" },
  terms: { version: "2026-09", accepted: true, acceptedAt: "2026-09-26 10:00:00", withdrawalAccepted: true, withdrawalAcceptedAt: "2026-09-26 10:00:00" },
  balance: 12, purchased: 12, subscription: null,
  costs: { exam: 2, qcm: 1, exercise: 1, assist: 0.1 }, usedToday: 0,
  quotas: { gen: null, assist: null }, transactions: [],
  offers: [
    { plan: "pro_monthly", kind: "subscription", label: "Pro — mensuel", credits: 20, interval: "month", price: { amount: 14.9, currency: "EUR" } },
    { plan: "pro_yearly", kind: "subscription", label: "Pro — annuel", credits: 20, interval: "year", price: { amount: 119, currency: "EUR" } },
    { plan: "credits_10", kind: "pack", label: "Pack de 10 crédits", credits: 10, interval: null, price: { amount: 9, currency: "EUR" } },
  ],
};
const noop = () => {};
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);
const isDisabled = (tag: string) => /\sdisabled(?:=""|(?=[\s>]))/.test(tag);

test("pendant un départ vers Stripe, TOUTES les offres sont désactivées", async () => {
  const { BillingView } = await import("../app/compte/BillingPanel");
  const html = renderToStaticMarkup(createElement(BillingView, {
    data: base as never, busy: "checkout:credits_10", actionError: null, retour: null,
    onRefresh: noop, onAcceptTerms: noop, onCheckout: noop, onPortal: noop,
  }));
  const offers = buttons(html).filter((b) => /Acheter|S’abonner|S'abonner/.test(b));
  assert.equal(offers.length, 3, "les trois offres sont rendues");
  assert.equal(offers.filter(isDisabled).length, 3, "aucune ne doit rester cliquable");
});
