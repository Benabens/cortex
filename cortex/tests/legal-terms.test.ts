/**
 * B9 / pages légales — on n'encaisse pas sans CGV :
 *  - les liens légaux viennent de variables d'environnement (LEGAL_*_URL) ;
 *  - en production avec facturation, s'il en manque un, l'achat est FERMÉ
 *    (API : purchase.enabled=false, checkout → 503) ;
 *  - l'acceptation des CGV (date + version) est tracée côté serveur et exigée
 *    avant le premier achat (checkout → 403 sans acceptation de la version courante).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-legal-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.BILLING_ENABLED = "1";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
process.env.AUTH_URL = "https://cortex.example.ch";
process.env.LEGAL_TERMS_VERSION = "2026-09";
const env = process.env as Record<string, string | undefined>;
const LEGAL = ["LEGAL_TERMS_URL", "LEGAL_PRIVACY_URL", "LEGAL_REFUND_URL", "LEGAL_NOTICE_URL"];
const setLegal = () => { for (const k of LEGAL) env[k] = `https://cortex.example.ch/${k.toLowerCase()}`; };
const clearLegal = () => { for (const k of LEGAL) delete env[k]; };

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(() => {
  for (const k of ["CORTEX_DATA_DIR", "BILLING_ENABLED", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "AUTH_URL", "LEGAL_TERMS_VERSION", "NODE_ENV", ...LEGAL]) delete env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (url: string, body: unknown, user = "alice") =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", "x-cortex-user": user }, body: JSON.stringify(body) });

test("legalLinks / purchasesAllowed : liens depuis l'env ; en production sans les quatre liens, achat fermé", async () => {
  const legal = await import("../lib/legal");
  clearLegal();
  assert.deepEqual(legal.legalLinks(), { terms: null, privacy: null, refund: null, notice: null });
  assert.equal(legal.legalReady(), false);
  env.NODE_ENV = "production";
  assert.equal(legal.purchasesAllowed().enabled, false);
  assert.match(legal.purchasesAllowed().reason ?? "", /légaux|CGV/i);
  setLegal();
  assert.equal(legal.legalReady(), true);
  assert.equal(legal.purchasesAllowed().enabled, true);
  delete env.STRIPE_WEBHOOK_SECRET;
  assert.equal(legal.purchasesAllowed().enabled, false, "sans configuration Stripe complète, pas d'achat");
  env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
  delete env.NODE_ENV;
  clearLegal();
  assert.equal(legal.purchasesAllowed().enabled, true, "hors production, l'absence de liens n'empêche pas de tester le paiement");
  assert.equal(legal.termsVersion(), "2026-09");
});

test("acceptation des CGV : tracée (utilisateur, version, date), exposée par /api/billing", async () => {
  setLegal();
  const terms = await import("../app/api/billing/terms/route");
  const billing = await import("../app/api/billing/route");
  const before_ = await (await billing.GET(post("http://cortex.test/api/billing", {}) as never)).json();
  assert.equal(before_.terms.accepted, false);
  assert.equal(before_.terms.version, "2026-09");
  assert.deepEqual(Object.keys(before_.legal).sort(), ["notice", "privacy", "refund", "terms"]);
  const bad = await terms.POST(post("http://cortex.test/api/billing/terms", { version: "2020-01" }));
  assert.equal(bad.status, 400, "une autre version que la courante n'est pas une acceptation");
  const ok = await terms.POST(post("http://cortex.test/api/billing/terms", { version: "2026-09" }));
  assert.equal(ok.status, 200, await ok.text());
  const after_ = await (await billing.GET(post("http://cortex.test/api/billing", {}) as never)).json();
  assert.equal(after_.terms.accepted, true);
  assert.match(after_.terms.acceptedAt, /^\d{4}-\d{2}-\d{2}/);
  const { authGet } = await import("../db/auth-store");
  const row = await authGet<{ version: string }>(`SELECT version FROM terms_acceptances WHERE user_id = ?`, "alice");
  assert.equal(row?.version, "2026-09");
  // Rejouer l'acceptation ne crée pas de doublon.
  assert.equal((await terms.POST(post("http://cortex.test/api/billing/terms", { version: "2026-09" }))).status, 200);
});

test("checkout : sans acceptation des CGV → 403 avant tout appel Stripe ; achat fermé en prod sans liens → 503", async () => {
  setLegal();
  const { POST } = await import("../app/api/billing/checkout/route");
  const r403 = await POST(post("http://cortex.test/api/billing/checkout", { plan: "credits_10" }, "bob"));
  const body403 = await r403.text();
  assert.equal(r403.status, 403, body403);
  assert.match(body403, /conditions/i);
  env.NODE_ENV = "production";
  clearLegal();
  const r503 = await POST(post("http://cortex.test/api/billing/checkout", { plan: "credits_10" }, "alice"));
  assert.equal(r503.status, 503, await r503.text());
  delete env.NODE_ENV;
});

test("la suppression de compte efface l'acceptation des CGV", async () => {
  const { authRun, authGet } = await import("../db/auth-store");
  await authRun(`INSERT INTO users (id, email, name) VALUES (?,?,?)`, "alice", "alice@example.com", "alice");
  const { deleteAccount } = await import("../lib/account-deletion");
  await deleteAccount("alice");
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM terms_acceptances WHERE user_id = ?`, "alice"))?.n, 0);
});
