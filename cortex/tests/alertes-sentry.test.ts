/**
 * AUDIT DU 14/11/2026, n° 13 — aucune alerte pour Ben : disque plein, job en échec définitif,
 * webhook Stripe en erreur, tout passait sans prévenir Sentry. Chaque chemin le signale
 * désormais, avec des étiquettes techniques seulement.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-alertes-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.AUTH_ENABLED = "0";
process.env.STORAGE_QUOTA_MB = "1";
const MiB = 1024 * 1024;

type Captured = { e: unknown; tags: Record<string, string> };
const captured: Captured[] = [];
let flushed = 0;

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
  process.env.SENTRY_DSN = "https://exemple@o0.ingest.sentry.io/1";
  const { initErrorTracking } = await import("../lib/observability");
  await initErrorTracking({
    load: async () => ({
      init: () => {},
      captureException: (e: unknown, hint?: Record<string, unknown>) => { captured.push({ e, tags: (hint?.tags ?? {}) as Record<string, string> }); },
      flush: async () => { flushed++; return true; },
    }),
  });
});
beforeEach(() => { captured.length = 0; });
after(async () => {
  const { resetErrorTrackingForTests } = await import("../lib/observability");
  resetErrorTrackingForTests();
  const { setStatfsForTests } = await import("../lib/storage-quota");
  setStatfsForTests(null);
  for (const k of ["CORTEX_DATA_DIR", "AUTH_ENABLED", "STORAGE_QUOTA_MB", "SENTRY_DSN"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("volume presque plein : l'envoi est refusé ET Sentry est prévenu (« l'équipe est prévenue » devient vrai)", async () => {
  const { checkStorage, setStatfsForTests, resetVolumeAlertForTests } = await import("../lib/storage-quota");
  resetVolumeAlertForTests();
  setStatfsForTests(() => ({ free: 5 * 1024 * MiB, total: 100 * 1024 * MiB }));
  const r = await checkStorage("owner", 10);
  assert.equal(r?.status, 413);
  assert.equal(captured.length, 1, JSON.stringify(captured));
  assert.equal(captured[0].tags.area, "storage");
  assert.equal(captured[0].tags.alert, "volume_full");
  assert.ok(!JSON.stringify(captured[0].tags).includes("owner"), "aucun identifiant de compte dans les étiquettes");
  setStatfsForTests(null);
});

test("I7 : volume sous 20 % libres — l'envoi passe encore, mais Sentry prévient avant le mur des 10 % (une fois)", async () => {
  const { checkStorage, setStatfsForTests, resetVolumeAlertForTests } = await import("../lib/storage-quota");
  resetVolumeAlertForTests();
  captured.length = 0;
  setStatfsForTests(() => ({ free: 15 * 1024 * MiB, total: 100 * 1024 * MiB }));
  try {
    assert.equal(await checkStorage("owner", 10), null, "15 % libres : l'envoi passe");
    assert.equal(await checkStorage("owner", 10), null);
    const low = captured.filter((c) => c.tags.alert === "volume_low");
    assert.equal(low.length, 1, JSON.stringify(captured.map((c) => c.tags)));
    assert.match(String((low[0].e as Error).message), /15 %/);
    captured.length = 0;
    setStatfsForTests(() => ({ free: 50 * 1024 * MiB, total: 100 * 1024 * MiB }));
    resetVolumeAlertForTests();
    assert.equal(await checkStorage("owner", 10), null);
    assert.equal(captured.length, 0, "50 % libres : rien");
  } finally {
    setStatfsForTests(null);
  }
});

test("volume plein : une alerte par heure et par process, pas une par envoi refusé", async () => {
  const { checkStorage, setStatfsForTests, resetVolumeAlertForTests } = await import("../lib/storage-quota");
  resetVolumeAlertForTests();
  setStatfsForTests(() => ({ free: 5 * 1024 * MiB, total: 100 * 1024 * MiB }));
  for (let i = 0; i < 5; i++) await checkStorage("owner", 10);
  assert.equal(captured.length, 1);
  setStatfsForTests(null);
});

test("quota du COMPTE atteint (volume sain) : refus, mais aucune alerte — ce n'est pas une panne", async () => {
  const { checkStorage, setStatfsForTests, resetVolumeAlertForTests } = await import("../lib/storage-quota");
  resetVolumeAlertForTests();
  setStatfsForTests(() => ({ free: 80 * 1024 * MiB, total: 100 * 1024 * MiB }));
  const r = await checkStorage("owner", 5 * MiB);
  assert.equal(r?.status, 413);
  assert.equal(captured.length, 0);
  setStatfsForTests(null);
});

test("flushErrorTracking : vide la file du SDK avant la sortie d'un worker (sinon l'erreur part avec le process)", async () => {
  const { flushErrorTracking } = await import("../lib/observability");
  const before = flushed;
  await flushErrorTracking();
  assert.equal(flushed, before + 1);
});

test("webhook Stripe en erreur (500, Stripe réessaie) : Sentry est prévenu avec le type d'événement, sans identifiant", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fake_key_local_only";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_local";
  process.env.BILLING_ENABLED = "1";
  try {
    const { POST } = await import("../app/api/billing/webhook/route");
    const { NextRequest } = await import("next/server");
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe("sk_test_fake_key_local_only");
    // Facture d'abonnement Cortex dont le client n'est lié à aucun compte : erreur RETRYABLE → 500.
    const payload = JSON.stringify({
      id: "evt_alerte_1", object: "event", livemode: false, type: "invoice.paid",
      data: { object: { id: "in_alerte_1", object: "invoice", customer: "cus_inconnu", subscription: "sub_alerte_1", metadata: { app: "cortex" }, lines: { data: [] } } },
    });
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test_local" });
    const res = await POST(new NextRequest("http://localhost/api/billing/webhook", { method: "POST", body: payload, headers: { "stripe-signature": sig } }));
    assert.equal(res.status, 500, await res.text());
    const alert = captured.find((c) => c.tags.area === "billing");
    assert.ok(alert, JSON.stringify(captured.map((c) => c.tags)));
    assert.equal(alert!.tags.step, "webhook");
    assert.equal(alert!.tags.event_type, "invoice.paid");
    assert.ok(!JSON.stringify(alert!.tags).includes("cus_inconnu"));
  } finally {
    for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "BILLING_ENABLED"]) delete process.env[k];
  }
});

/**
 * AUDIT FUITES DU 17/11, B5 — un webhook à signature invalide (secret tourné, mauvais endpoint)
 * était refusé en 400 sans un mot : Stripe abandonne au bout de 3 jours, les clients ont payé
 * sans crédits. Le refus reste un 400 (un tiers ne doit rien apprendre), mais Sentry est prévenu,
 * une fois par heure et par cause au plus (un robot qui frappe l'URL ne vide pas le quota).
 */
async function postWebhook(payload: string, sig: string) {
  const { POST } = await import("../app/api/billing/webhook/route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/billing/webhook", { method: "POST", body: payload, headers: { "stripe-signature": sig } }));
}

test("webhook Stripe à signature invalide : 400, et Sentry est prévenu une seule fois par heure", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fake_key_local_only";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_local";
  try {
    const { resetErrorTrackingThrottleForTests } = await import("../lib/observability");
    resetErrorTrackingThrottleForTests();
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe("sk_test_fake_key_local_only");
    const payload = JSON.stringify({ id: "evt_sig_1", object: "event", livemode: false, type: "invoice.paid", data: { object: {} } });
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_un_autre_secret" });
    for (let i = 0; i < 3; i++) {
      const res = await postWebhook(payload, sig);
      assert.equal(res.status, 400);
    }
    const alerts = captured.filter((c) => c.tags.area === "billing");
    assert.equal(alerts.length, 1, JSON.stringify(captured.map((c) => c.tags)));
    assert.equal(alerts[0].tags.step, "webhook_signature");
    assert.ok(!JSON.stringify(alerts[0]).includes("evt_sig_1"), "rien du corps non vérifié dans l'alerte");
  } finally {
    for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) delete process.env[k];
  }
});

test("webhook frappé par un robot (en-tête qui n'a pas la forme de Stripe, ou périmé) : 400 sans alerte — l'alerte « secret ? » reste lisible", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fake_key_local_only";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_local";
  try {
    const { resetErrorTrackingThrottleForTests } = await import("../lib/observability");
    resetErrorTrackingThrottleForTests();
    const payload = JSON.stringify({ id: "evt_robot", object: "event", type: "invoice.paid", data: { object: {} } });
    const stale = `t=${Math.floor(Date.now() / 1000) - 3600},v1=${"a".repeat(64)}`;
    for (const sig of ["abc", "t=1,v1=zz", stale]) assert.equal((await postWebhook(payload, sig)).status, 400);
    assert.equal(captured.filter((c) => c.tags.area === "billing").length, 0, JSON.stringify(captured.map((c) => c.tags)));
  } finally {
    for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) delete process.env[k];
  }
});

test("webhook Stripe de livemode incohérent avec la clé : 400, et Sentry est prévenu", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fake_key_local_only";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_local";
  try {
    const { resetErrorTrackingThrottleForTests } = await import("../lib/observability");
    resetErrorTrackingThrottleForTests();
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe("sk_test_fake_key_local_only");
    // Événement LIVE signé avec le bon secret, alors que la clé est de test : mauvais branchement.
    const payload = JSON.stringify({ id: "evt_live_1", object: "event", livemode: true, type: "invoice.paid", data: { object: {} } });
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test_local" });
    const res = await postWebhook(payload, sig);
    assert.equal(res.status, 400);
    const alert = captured.find((c) => c.tags.area === "billing");
    assert.ok(alert, JSON.stringify(captured.map((c) => c.tags)));
    assert.equal(alert!.tags.step, "webhook_livemode");
    assert.equal(alert!.tags.event_type, "invoice.paid");
  } finally {
    for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) delete process.env[k];
  }
});

/**
 * AUDIT FUITES DU 17/11, I14 — un lien magique qui ne partait pas (quota Resend atteint, clé
 * révoquée) restait invisible : Auth.js avale l'erreur, l'étudiant lit « connexion indisponible ».
 * L'échec d'envoi prévient Sentry (une fois par heure), sans l'adresse.
 */
test("lien magique non envoyé (transport en erreur) : l'échec remonte et Sentry est prévenu, sans l'adresse", async () => {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => { res.statusCode = 503; res.end("quota atteint pour ana@exemple.ch"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const saved = { endpoint: process.env.AUTH_EMAIL_ENDPOINT, resend: process.env.RESEND_API_KEY };
  delete process.env.RESEND_API_KEY;
  process.env.AUTH_EMAIL_ENDPOINT = `http://127.0.0.1:${port}/send`;
  try {
    const { resetErrorTrackingThrottleForTests } = await import("../lib/observability");
    resetErrorTrackingThrottleForTests();
    const { authProviders } = await import("../lib/auth-providers");
    const email = authProviders({ AUTH_EMAIL_ENABLED: "1", AUTH_EMAIL_ENDPOINT: process.env.AUTH_EMAIL_ENDPOINT })
      .find((p) => (p as { id?: string }).id === "email") as unknown as { sendVerificationRequest: (p: { identifier: string; url: string }) => Promise<void> };
    assert.ok(email, "fournisseur e-mail configuré");
    for (let i = 0; i < 2; i++) {
      await assert.rejects(email.sendVerificationRequest({ identifier: "ana@exemple.ch", url: "https://cortex.test/api/auth/callback/email?token=x" }));
    }
    const alerts = captured.filter((c) => c.tags.area === "auth");
    assert.equal(alerts.length, 1, JSON.stringify(captured.map((c) => c.tags)));
    assert.equal(alerts[0].tags.alert, "magic_link_send");
    assert.ok(!JSON.stringify(alerts[0]).includes("ana@exemple.ch"), "aucune adresse dans l'alerte");
    assert.ok(!String((alerts[0].e as Error).message).includes("token=x"), "aucun lien de connexion dans l'alerte");
  } finally {
    server.close();
    if (saved.endpoint === undefined) delete process.env.AUTH_EMAIL_ENDPOINT; else process.env.AUTH_EMAIL_ENDPOINT = saved.endpoint;
    if (saved.resend !== undefined) process.env.RESEND_API_KEY = saved.resend;
  }
});

test("job abandonné par la réconciliation (worker mort, tentatives épuisées) : Sentry est prévenu", async () => {
  const jobs = await import("../lib/jobs");
  const { q, nowStr } = await import("../db/q");
  const { runWithCourse } = await import("../db/client");
  await runWithCourse("algo", async () => {
    await jobs.ensureJobsSchema();
    const id = await q.insert(
      `INSERT INTO jobs (type, target, status, current_step, progress, pid, attempts, max_attempts, created_at, updated_at)
       VALUES (?,?,'running','Génération…',30,999999,2,2,?,?)`,
      "qcm", null, nowStr(-180_000), nowStr(-180_000),
    );
    await jobs.reconcileStaleJobs();
    const row = await q.get<{ status: string }>(`SELECT status FROM jobs WHERE id = ?`, id);
    assert.equal(row?.status, "error");
    const alert = captured.find((c) => c.tags.area === "jobs");
    assert.ok(alert, JSON.stringify(captured.map((c) => c.tags)));
    assert.equal(alert!.tags.failure, "job_abandoned", "vocabulaire commun des échecs (lib/failure-report)");
    assert.equal(alert!.tags.job_type, "qcm");
  });
});

test("job remis en file (tentative restante) : pas d'alerte, la reprise automatique s'en charge", async () => {
  const jobs = await import("../lib/jobs");
  const { q, nowStr } = await import("../db/q");
  const { runWithCourse } = await import("../db/client");
  await runWithCourse("algo", async () => {
    await jobs.ensureJobsSchema();
    // Le propriétaire n'a pas de débit : sa référence suffit à valider la reprise.
    await q.insert(
      `INSERT INTO jobs (type, target, status, current_step, progress, pid, attempts, max_attempts, credit_ref, created_at, updated_at)
       VALUES (?,?,'running','Génération…',30,999999,0,2,?,?,?)`,
      "ingest", null, null, nowStr(-180_000), nowStr(-180_000),
    );
    await jobs.reconcileStaleJobs();
    assert.equal(captured.filter((c) => c.tags.area === "jobs").length, 0, JSON.stringify(captured.map((c) => c.tags)));
  });
});
