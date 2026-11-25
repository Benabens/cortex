/**
 * WEBHOOK RAILWAY (25/11/2026) — Railway appelle POST /api/ops/railway-webhook?token=… quand un
 * déploiement échoue, plante, est tué faute de mémoire, ou qu'un monitor se déclenche. Cortex
 * envoie aussitôt un mail court au destinataire du bilan (service, événement, heure, lien), sans
 * aucun appel au modèle. Jeton comparé en temps constant à RAILWAY_WEBHOOK_TOKEN (absente =
 * point désactivé, 404) ; corps borné à 64 ko ; au plus un mail par environnement, service et
 * type d'événement toutes les 15 min, même entre plusieurs process (claim-once).
 *
 * Données fictives : projet, services et identifiants inventés.
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-railway-webhook-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.OPS_DIGEST_TO = "proprietaire@exemple.test";
process.env.OPS_RAILWAY_URL = "https://railway.com/project/repli-fictif";
// Aucun appel au modèle possible.
process.env.LLM_PROVIDER = "claude-code";
process.env.CORTEX_CLAUDE_BIN = "/usr/bin/false";
delete process.env.CORTEX_USER;

const TOKEN = "jeton-fictif-0123456789abcdef";
const NOW = new Date("2026-11-25T10:05:00Z"); // 11 h 05 à Zurich
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

type Mail = { to: string; subject: string; text: string; html?: string; idempotencyKey?: string };
let sent: Mail[] = [];
const send = async (m: Mail) => { sent.push(m); return { ok: true as const }; };

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ENV_PROD = "22222222-2222-4222-8222-222222222222";
const ENV_PREVIEW = "33333333-3333-4333-8333-333333333333";
const SVC_APP = "44444444-4444-4444-8444-444444444444";
const SVC_PG = "55555555-5555-4555-8555-555555555555";

function event(type: string, o: { service?: { id: string; name: string } | null; env?: string; details?: Record<string, unknown> } = {}) {
  const service = o.service === undefined ? { id: SVC_APP, name: "cortex-app" } : o.service;
  return {
    type,
    details: { id: "dep-fictif", source: "GitHub", status: "FAILED", branch: "main", commitHash: "abc123", commitAuthor: "Alice Fictive", commitMessage: "Corrige le cours secret", ...o.details },
    resource: {
      workspace: { id: "ws-fictif", name: "Atelier fictif" },
      project: { id: PROJECT, name: "projet-fictif" },
      environment: { id: o.env ?? ENV_PROD, name: o.env === ENV_PREVIEW ? "pr-12" : "production", isEphemeral: o.env === ENV_PREVIEW },
      ...(service ? { service } : {}),
      deployment: { id: "66666666-6666-4666-8666-666666666666" },
    },
    severity: "WARNING",
    timestamp: "2026-11-25T10:04:58.000Z",
  };
}

function req(body: unknown, opts: { token?: string | null; raw?: string } = {}) {
  const token = opts.token === undefined ? TOKEN : opts.token;
  const url = `http://cortex.test/api/ops/railway-webhook${token === null ? "" : `?token=${encodeURIComponent(token)}`}`;
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: opts.raw ?? JSON.stringify(body) });
}

async function hook(r: Request, now = NOW) {
  const { handleRailwayWebhook } = await import("../lib/railway-webhook");
  return handleRailwayWebhook(r, { now, send });
}

beforeEach(async () => {
  sent = [];
  process.env.RAILWAY_WEBHOOK_TOKEN = TOKEN;
  const { authRun } = await import("../db/auth-store");
  await authRun(`DELETE FROM app_meta WHERE key LIKE 'railway_webhook:%'`).catch(() => {});
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("variable absente : point désactivé (404), rien n'est envoyé", async () => {
  delete process.env.RAILWAY_WEBHOOK_TOKEN;
  const res = await hook(req(event("Deployment.crashed")));
  assert.equal(res.status, 404);
  assert.equal(sent.length, 0);
});

test("jeton absent, faux, ou d'une autre longueur : 401, rien n'est envoyé", async () => {
  for (const token of [null, "", "jeton-fictif-0123456789abcdeX", "court", `${TOKEN}-plus-long`]) {
    const res = await hook(req(event("Deployment.crashed"), { token }));
    assert.equal(res.status, 401, String(token));
  }
  assert.equal(sent.length, 0);
});

test("corps au-delà de 64 ko : 413, rien n'est envoyé", async () => {
  const big = event("Deployment.crashed", { details: { padding: "x".repeat(70 * 1024) } });
  const res = await hook(req(big));
  assert.equal(res.status, 413);
  assert.equal(sent.length, 0);
});

test("chacun des quatre événements envoie un mail court : service, événement, heure, lien Railway", async () => {
  const cases: Array<[string, RegExp]> = [
    ["Deployment.failed", /déploiement en échec/i],
    ["Deployment.crashed", /planté/i],
    ["Deployment.oom_killed", /mémoire/i],
    ["Monitor.triggered", /monitor/i],
  ];
  for (const [type, label] of cases) {
    sent = [];
    const res = await hook(req(event(type)));
    assert.equal(res.status, 200, type);
    assert.equal(sent.length, 1, type);
    const m = sent[0];
    assert.equal(m.to, "proprietaire@exemple.test");
    assert.match(m.subject, /^Cortex — Railway/);
    assert.match(m.subject, label);
    assert.match(m.subject, /cortex-app/);
    assert.match(m.text, /cortex-app/);
    assert.match(m.text, /production/);
    assert.match(m.text, /25\.11\.2026 11:04/, "heure de l'événement, à Zurich");
    assert.ok(m.text.includes(`https://railway.com/project/${PROJECT}/service/${SVC_APP}?environmentId=${ENV_PROD}`), m.text);
    assert.ok(m.idempotencyKey, "clé d'idempotence chez le fournisseur");
  }
});

test("rafale : un seul mail par environnement, service et type sur 15 min, même à cheval sur un quart d'heure", async () => {
  // 11 h 05 puis 11 h 14 : même quart d'heure.
  await hook(req(event("Deployment.crashed")), NOW);
  await hook(req(event("Deployment.crashed")), minutes(9));
  assert.equal(sent.length, 1);
  // 11 h 16 : autre quart d'heure, mais 11 min seulement après le mail → rien.
  await hook(req(event("Deployment.crashed")), minutes(11));
  assert.equal(sent.length, 1);
  // 11 h 21 : 16 min après le mail → un nouveau mail.
  const res = await hook(req(event("Deployment.crashed")), minutes(16));
  assert.equal(res.status, 200);
  assert.equal(sent.length, 2);
});

test("rafale : un autre type, un autre service ou un autre environnement passe quand même", async () => {
  await hook(req(event("Deployment.crashed")));
  await hook(req(event("Deployment.oom_killed")));
  await hook(req(event("Deployment.crashed", { service: { id: SVC_PG, name: "postgres" } })));
  await hook(req(event("Deployment.crashed", { env: ENV_PREVIEW })));
  assert.equal(sent.length, 4);
  assert.match(sent[3].text, /pr-12/);
});

test("payload inattendu : type inconnu ignoré (2xx), JSON invalide ou non-objet refusé (400), jamais de mail", async () => {
  for (const type of ["Deployment.success", "Deployment.building", "Volume.alert", "", 42]) {
    const res = await hook(req(event(type as string)));
    assert.ok(res.status >= 200 && res.status < 300, String(type));
  }
  for (const raw of ["{pas du json", "", "null", "[]", "\"Deployment.crashed\""]) {
    const res = await hook(req(null, { raw }));
    assert.equal(res.status, 400, raw);
  }
  assert.equal(sent.length, 0);
});

test("événement connu sans service : mail quand même, service « inconnu », lien de repli", async () => {
  const res = await hook(req(event("Monitor.triggered", { service: null })));
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /inconnu/);
});

test("aucune donnée personnelle ni secret dans le mail ; noms nettoyés et bornés", async () => {
  const evil = event("Deployment.crashed", { service: { id: "pas-un-uuid/../x?y", name: `cortex-app\n<script>alert(1)</script>${"z".repeat(300)}` } });
  await hook(req(evil));
  assert.equal(sent.length, 1);
  const all = JSON.stringify(sent[0]);
  for (const s of ["Alice Fictive", "cours secret", "abc123", TOKEN, "Atelier fictif", "<script>", "pas-un-uuid"]) assert.ok(!all.includes(s), s);
  assert.ok(!sent[0].subject.includes("\n"), "sujet sur une ligne");
  assert.ok(sent[0].subject.length < 160, "sujet borné");
  assert.ok(sent[0].text.includes("https://railway.com/project/repli-fictif"), "identifiant douteux → lien de repli");
});

test("envoi refusé net : la clé est rendue, la relance de Railway envoie ; envoi incertain : pas de second mail", async () => {
  const { handleRailwayWebhook } = await import("../lib/railway-webhook");
  const refused = await handleRailwayWebhook(req(event("Deployment.failed")), { now: NOW, send: async () => ({ ok: false as const, reason: "panne" }) });
  assert.ok(refused.status >= 500);
  await hook(req(event("Deployment.failed")), minutes(1));
  assert.equal(sent.length, 1, "la relance passe");

  sent = [];
  await handleRailwayWebhook(req(event("Deployment.oom_killed")), { now: NOW, send: async () => ({ ok: false as const, reason: "délai", uncertain: true as const }) });
  await hook(req(event("Deployment.oom_killed")), minutes(1));
  assert.equal(sent.length, 0, "un envoi peut-être parti n'est pas doublé");
});

test("proxy : le webhook est joignable sans session, le reste de /api/ops non", async () => {
  (process.env as Record<string, string | undefined>).AUTH_ENABLED = "1";
  const { publicPath } = await import("../proxy");
  assert.equal(publicPath("/api/ops/railway-webhook"), true);
  for (const p of ["/api/ops", "/api/ops/digest", "/api/opsx"]) assert.equal(publicPath(p), false, p);
});
