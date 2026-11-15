/**
 * AUDIT DU 14/11/2026, n° 7 — double abonnement : la garde lisait l'état en base, qui reste
 * « aucun » tant que le webhook n'est pas arrivé. Deux onglets Checkout payés donnaient deux
 * abonnements chez Stripe ; l'app n'en voyait qu'un, l'autre facturait quand même.
 * Désormais : un seul Checkout d'abonnement ouvert par compte (le précédent est expiré), un
 * client Stripe unique par compte, et l'état réel des abonnements de ce client lu chez Stripe.
 * Faux client Stripe en mémoire : zéro réseau.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-checkout-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.AUTH_URL = "https://cortex.example.ch";

type Session = { id: string; url: string; status: "open" | "complete" | "expired"; params: Record<string, unknown>; customer?: string };
type Sub = { id: string; customer: string; status: string };

function fakeStripe() {
  const sessions = new Map<string, Session>();
  const customers: Array<{ id: string; params: Record<string, unknown>; idempotencyKey?: string }> = [];
  const subs: Sub[] = [];
  let n = 0;
  const tag = Math.random().toString(36).slice(2, 8); // ids uniques entre faux (la base est commune aux tests)
  let failCreate = false;
  let customersForbidden = false;
  let afterCreate: (() => Promise<void>) | null = null;
  const stripe = {
    customers: {
      async create(params: Record<string, unknown>, opts?: { idempotencyKey?: string }) {
        if (customersForbidden) throw Object.assign(new Error("The provided key does not have the required permissions"), { type: "StripePermissionError", statusCode: 403 });
        const same = opts?.idempotencyKey && customers.find((c) => c.idempotencyKey === opts.idempotencyKey);
        if (same) return { id: same.id };
        const c = { id: `cus_${tag}_${++n}`, params, idempotencyKey: opts?.idempotencyKey };
        customers.push(c);
        return { id: c.id };
      },
    },
    subscriptions: {
      async list(p: { customer?: string }) { return { data: subs.filter((s) => s.customer === p.customer) }; },
    },
    checkout: {
      sessions: {
        async create(params: Record<string, unknown>) {
          await new Promise((r) => setTimeout(r, 20)); // le réseau : laisse une requête concurrente se glisser
          if (failCreate) throw new Error("Stripe indisponible");
          const s: Session = { id: `cs_${tag}_${++n}`, url: `https://checkout.stripe.test/${n}`, status: "open", params };
          sessions.set(s.id, s);
          if (afterCreate) { const fn = afterCreate; afterCreate = null; await fn(); }
          return { id: s.id, url: s.url };
        },
        async retrieve(id: string) {
          const s = sessions.get(id);
          if (!s) throw Object.assign(new Error("No such session"), { code: "resource_missing" });
          return { id: s.id, url: s.url, status: s.status, customer: s.customer ?? null };
        },
        async expire(id: string) {
          const s = sessions.get(id)!;
          if (s.status !== "open") throw new Error("Only open sessions can be expired");
          s.status = "expired";
          return { id };
        },
      },
    },
  };
  return {
    stripe, sessions, customers, subs,
    pay(id: string) {
      const s = sessions.get(id)!;
      s.status = "complete";
      s.customer = s.params.customer ? String(s.params.customer) : `cus_${tag}_checkout${++n}`; // sans client : Checkout en crée un
      subs.push({ id: `sub_${tag}_${++n}`, customer: s.customer, status: "active" });
    },
    afterNextCreate(fn: () => Promise<void>) { afterCreate = fn; },
    failNextCreates(v: boolean) { failCreate = v; },
    forbidCustomers() { customersForbidden = true; },
  };
}

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(() => {
  for (const k of ["CORTEX_DATA_DIR", "AUTH_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sub = (userId: string) => ({ userId, plan: "pro_monthly" as const, priceId: "price_m", email: `${userId}@example.com` });

test("deux onglets l'un après l'autre : le premier Checkout est expiré, un seul reste payable", async () => {
  const { openCheckout } = await import("../lib/billing/checkout-session");
  const f = fakeStripe();
  const a = await openCheckout({ stripe: f.stripe, ...sub("u-onglets") });
  const b = await openCheckout({ stripe: f.stripe, ...sub("u-onglets") });
  assert.ok(a.ok && b.ok, JSON.stringify({ a, b }));
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(f.sessions.get(a.sessionId)!.status, "expired", "l'ancien onglet ne peut plus payer");
  assert.equal(f.sessions.get(b.sessionId)!.status, "open");
});

test("double clic simultané : une seule session créée, l'autre requête est refusée (409)", async () => {
  const { openCheckout } = await import("../lib/billing/checkout-session");
  const f = fakeStripe();
  const [a, b] = await Promise.all([openCheckout({ stripe: f.stripe, ...sub("u-clic") }), openCheckout({ stripe: f.stripe, ...sub("u-clic") })]);
  const oks = [a, b].filter((r) => r.ok);
  assert.equal(oks.length, 1, JSON.stringify({ a, b }));
  const refused = [a, b].find((r) => !r.ok)!;
  assert.equal(!refused.ok && refused.status, 409);
  assert.equal(f.sessions.size, 1);
});

test("premier onglet PAYÉ, webhook pas encore arrivé : le second est refusé d'après l'état réel chez Stripe", async () => {
  const { openCheckout } = await import("../lib/billing/checkout-session");
  const f = fakeStripe();
  const a = await openCheckout({ stripe: f.stripe, ...sub("u-paye") });
  assert.ok(a.ok);
  f.pay(a.sessionId);
  const b = await openCheckout({ stripe: f.stripe, ...sub("u-paye") });
  assert.equal(b.ok, false);
  assert.equal(!b.ok && b.status, 409);
  assert.match(!b.ok ? b.error : "", /abonnement/i);
  assert.equal(f.sessions.size, 1, "aucune seconde session");
});

test("client Stripe unique par compte : créé une fois (avec les métadonnées Cortex), réutilisé par les packs et l'abonnement", async () => {
  const { openCheckout } = await import("../lib/billing/checkout-session");
  const f = fakeStripe();
  const pack = await openCheckout({ stripe: f.stripe, userId: "u-client", plan: "credits_10", priceId: "price_p", email: "u@example.com" });
  const pro = await openCheckout({ stripe: f.stripe, userId: "u-client", plan: "pro_yearly", priceId: "price_y", email: "u@example.com" });
  assert.ok(pack.ok && pro.ok);
  assert.equal(f.customers.length, 1);
  assert.deepEqual(f.customers[0].params.metadata, { app: "cortex", cortexUserId: "u-client" });
  for (const id of [pack.sessionId, pro.sessionId]) {
    const p = f.sessions.get(id)!.params;
    assert.equal(p.customer, f.customers[0].id);
    assert.equal("customer_email" in p, false, "customer et customer_email sont exclusifs chez Stripe");
    assert.equal("customer_creation" in p, false);
  }
});

test("client déjà connu par un ancien abonnement (subscriptions.customer_id) : c'est lui qui est réutilisé", async () => {
  const { openCheckout } = await import("../lib/billing/checkout-session");
  const { authRun } = await import("../db/auth-store");
  const { nowStr } = await import("../db/q");
  await authRun(`INSERT INTO subscriptions (user_id, customer_id, subscription_id, status, updated_at) VALUES (?,?,?,?,?)`, "u-ancien", "cus_ancien", "sub_ancien", "canceled", nowStr());
  const f = fakeStripe();
  const r = await openCheckout({ stripe: f.stripe, ...sub("u-ancien") });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(f.customers.length, 0);
  assert.equal(f.sessions.get(r.sessionId)!.params.customer, "cus_ancien");
});

test("le webhook retrouve le compte par le client Stripe créé au checkout", async () => {
  const { openCheckout } = await import("../lib/billing/checkout-session");
  const { resolveUserByCustomer } = await import("../lib/billing/credits");
  const f = fakeStripe();
  await openCheckout({ stripe: f.stripe, userId: "u-webhook", plan: "credits_10", priceId: "price_p", email: null });
  assert.equal(await resolveUserByCustomer(f.customers[0].id), "u-webhook");
});

test("Stripe en panne à la création : le verrou est rendu, l'essai suivant passe", async () => {
  const { openCheckout } = await import("../lib/billing/checkout-session");
  const f = fakeStripe();
  f.failNextCreates(true);
  await assert.rejects(openCheckout({ stripe: f.stripe, ...sub("u-panne") }), /indisponible/);
  f.failNextCreates(false);
  const r = await openCheckout({ stripe: f.stripe, ...sub("u-panne") });
  assert.ok(r.ok, JSON.stringify(r));
});

test("la session d'abonnement expire d'elle-même au bout de 30 min : le verrou ne dure pas", async () => {
  const { openCheckout } = await import("../lib/billing/checkout-session");
  const f = fakeStripe();
  const r = await openCheckout({ stripe: f.stripe, ...sub("u-expire") });
  assert.ok(r.ok);
  const at = Number(f.sessions.get(r.sessionId)!.params.expires_at);
  const inMin = (at * 1000 - Date.now()) / 60_000;
  assert.ok(inMin > 30 && inMin < 32, `expires_at dans ${inMin} min`);
});

test("suppression du compte : son client Stripe et son verrou de checkout sont effacés", async () => {
  const { openCheckout } = await import("../lib/billing/checkout-session");
  const { deleteAccount } = await import("../lib/account-deletion");
  const { authGet, authRun } = await import("../db/auth-store");
  await authRun(`INSERT INTO users (id, email) VALUES (?, ?)`, "u-supprime", "supprime@example.com");
  const f = fakeStripe();
  assert.ok((await openCheckout({ stripe: f.stripe, ...sub("u-supprime") })).ok);
  const r = await deleteAccount("u-supprime");
  assert.equal(r.deleted, true, JSON.stringify(r));
  assert.equal(await authGet(`SELECT 1 FROM stripe_customers WHERE user_id = ?`, "u-supprime"), undefined);
  assert.equal(await authGet(`SELECT 1 FROM checkout_locks WHERE user_id = ?`, "u-supprime"), undefined);
});

test("clé restreinte sans le droit Customers : le checkout marche comme avant (client créé par Checkout), le verrou garde", async () => {
  const { openCheckout } = await import("../lib/billing/checkout-session");
  const f = fakeStripe();
  f.forbidCustomers();
  const pack = await openCheckout({ stripe: f.stripe, userId: "u-rk", plan: "credits_10", priceId: "price_p", email: "rk@example.com" });
  assert.ok(pack.ok, JSON.stringify(pack));
  const p = f.sessions.get(pack.sessionId)!.params;
  assert.equal(p.customer_email, "rk@example.com");
  assert.equal(p.customer_creation, "always");
  const a = await openCheckout({ stripe: f.stripe, ...sub("u-rk") });
  const b = await openCheckout({ stripe: f.stripe, ...sub("u-rk") });
  assert.ok(a.ok && b.ok);
  assert.equal(f.sessions.get(a.sessionId)!.status, "expired");
});

test("clé sans le droit Customers, premier onglet PAYÉ avant le webhook : le second est refusé d'après le client de la session payée", async () => {
  const { openCheckout } = await import("../lib/billing/checkout-session");
  const f = fakeStripe();
  f.forbidCustomers();
  const a = await openCheckout({ stripe: f.stripe, ...sub("u-rk-paid") });
  assert.ok(a.ok);
  f.pay(a.sessionId);
  const b = await openCheckout({ stripe: f.stripe, ...sub("u-rk-paid") });
  assert.equal(b.ok, false);
  assert.equal(!b.ok && b.status, 409);
  assert.equal(f.sessions.size, 1, "aucune seconde session payable");
});

test("base en panne juste après la création de la session : la session est expirée, rien ne reste payable sans verrou", async () => {
  const { openCheckout } = await import("../lib/billing/checkout-session");
  const { authRun } = await import("../db/auth-store");
  const f = fakeStripe();
  f.afterNextCreate(() => authRun(`ALTER TABLE checkout_locks RENAME TO checkout_locks_off`).then(() => {}));
  try {
    await assert.rejects(openCheckout({ stripe: f.stripe, ...sub("u-dbdown") }));
  } finally {
    await authRun(`ALTER TABLE checkout_locks_off RENAME TO checkout_locks`);
  }
  assert.deepEqual([...f.sessions.values()].map((x) => x.status), ["expired"]);
});
