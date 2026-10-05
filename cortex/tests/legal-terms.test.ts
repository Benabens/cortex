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
// Clé d'allure LIVE : en production ouverte au public, une clé de test ferme la vente (tests/purchases-test-mode).
process.env.STRIPE_SECRET_KEY = "sk_live_fake";
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
  // Rétractation (L221-28 13°) : l'accord exprès à l'exécution immédiate est OBLIGATOIRE avec les CGV.
  const noWaiver = await terms.POST(post("http://cortex.test/api/billing/terms", { version: "2026-09" }));
  const noWaiverText = await noWaiver.text();
  assert.equal(noWaiver.status, 400, noWaiverText);
  assert.match(noWaiverText, /rétractation/i);
  const ok = await terms.POST(post("http://cortex.test/api/billing/terms", { version: "2026-09", withdrawal: true }));
  assert.equal(ok.status, 200, await ok.text());
  const after_ = await (await billing.GET(post("http://cortex.test/api/billing", {}) as never)).json();
  assert.equal(after_.terms.accepted, true);
  assert.match(after_.terms.acceptedAt, /^\d{4}-\d{2}-\d{2}/);
  assert.equal(after_.terms.withdrawalAccepted, true);
  assert.match(after_.terms.withdrawalAcceptedAt, /^\d{4}-\d{2}-\d{2}/);
  const { authGet } = await import("../db/auth-store");
  const row = await authGet<{ version: string; withdrawal_waiver_at: string | null }>(`SELECT version, withdrawal_waiver_at FROM terms_acceptances WHERE user_id = ?`, "alice");
  assert.equal(row?.version, "2026-09");
  assert.match(row?.withdrawal_waiver_at ?? "", /^\d{4}-\d{2}-\d{2}/, "renonciation tracée avec sa date");
  // Rejouer l'acceptation ne crée pas de doublon et ne réécrit pas les dates.
  assert.equal((await terms.POST(post("http://cortex.test/api/billing/terms", { version: "2026-09", withdrawal: true }))).status, 200);
  const again = await authGet<{ withdrawal_waiver_at: string | null; n: number }>(`SELECT withdrawal_waiver_at, (SELECT count(*) FROM terms_acceptances WHERE user_id = 'alice') n FROM terms_acceptances WHERE user_id = ?`, "alice");
  assert.equal(Number(again?.n), 1);
  assert.equal(again?.withdrawal_waiver_at, row?.withdrawal_waiver_at);
});

test("compte ayant accepté les CGV AVANT la case de rétractation : checkout 400 tant qu'elle manque, puis OK après", async () => {
  setLegal();
  const { authRun, authGet } = await import("../db/auth-store");
  const { nowStr } = await import("../db/q");
  await authRun(`INSERT INTO terms_acceptances (user_id, version, accepted_at) VALUES (?,?,?)`, "carl", "2026-09", nowStr());
  const { POST } = await import("../app/api/billing/checkout/route");
  const r400 = await POST(post("http://cortex.test/api/billing/checkout", { plan: "credits_10" }, "carl"));
  const r400Text = await r400.text();
  assert.equal(r400.status, 400, r400Text);
  assert.match(r400Text, /rétractation/i);
  const terms = await import("../app/api/billing/terms/route");
  assert.equal((await terms.POST(post("http://cortex.test/api/billing/terms", { version: "2026-09", withdrawal: true }, "carl"))).status, 200);
  const row = await authGet<{ accepted_at: string; withdrawal_waiver_at: string | null }>(`SELECT accepted_at, withdrawal_waiver_at FROM terms_acceptances WHERE user_id = ?`, "carl");
  assert.ok(row?.withdrawal_waiver_at, "la renonciation s'ajoute à la ligne existante");
  // La garde légale est levée : l'état exposé le confirme (le checkout appellerait ensuite Stripe — hors de ce test hermétique).
  const { termsState } = await import("../lib/legal");
  const st = await termsState("carl");
  assert.equal(st.accepted && st.withdrawalAccepted, true);
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

test("un compte déjà abonné ne peut pas ouvrir un second abonnement (refus serveur, avant tout appel Stripe)", async () => {
  setLegal();
  const { POST } = await import("../app/api/billing/checkout/route");
  const credits = await import("../lib/billing/credits");
  const terms = await import("../app/api/billing/terms/route");
  // Compte en règle (CGV + renonciation) et abonnement Pro en cours.
  assert.equal((await terms.POST(post("http://cortex.test/api/billing/terms", { version: "2026-09", withdrawal: true }, "nina"))).status, 200);
  await credits.grantSubscriptionMonth({
    userId: "nina", customerId: "cus_nina", subscriptionId: "sub_nina", plan: "cortex_pro_monthly",
    periodStart: new Date(Date.now() - 86400_000).toISOString().slice(0, 19).replace("T", " "),
    periodEnd: new Date(Date.now() + 29 * 86400_000).toISOString().slice(0, 19).replace("T", " "),
  });
  for (const plan of ["pro_monthly", "pro_yearly"]) {
    const r = await POST(post("http://cortex.test/api/billing/checkout", { plan }, "nina"));
    const body = await r.text();
    assert.equal(r.status, 409, `${plan} → ${r.status} ${body}`);
    assert.match(body, /abonnement/i);
  }
  // Le pack de crédits reste achetable pendant un abonnement (il s'y ajoute) : la
  // garde ne s'y applique pas, la route va jusqu'à Stripe — qui refuse la clé
  // factice de ce test. C'est la preuve qu'on a passé la garde.
  await assert.rejects(
    POST(post("http://cortex.test/api/billing/checkout", { plan: "credits_10" }, "nina")),
    /Invalid API Key/,
  );
});
