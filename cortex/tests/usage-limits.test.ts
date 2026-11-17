/**
 * LIMITES D'USAGE (lib/billing/limits) — une seule règle pour tous les chemins :
 *  - l'affichage (getUsageLimits, GET /api/usage), le pré-contrôle des routes
 *    (preflightGeneration), la réservation atomique (reserveGeneration) et le
 *    pré-contrôle MCP (confirmCost) refusent le même lancement avec le même message ;
 *  - deux lancements simultanés ne passent pas tous deux sous le calcul du jour ;
 *  - le compte propriétaire est exempté du plafond du jour par compte, pas du
 *    fusible global ;
 *  - rien de ce que voit l'étudiant ne contient de dollars ni de nom de variable.
 * Postgres réel (PGlite), facturation active, fournisseur payant déclaré (aucun
 * appel n'est fait : les dépenses sont écrites directement dans llm_usage).
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

const ENV: Record<string, string> = {
  DB_DRIVER: "postgres",
  DATABASE_URL: "pglite://memory",
  BILLING_ENABLED: "1",
  SIGNUP_FREE_CREDITS: "0",
  LLM_PROVIDER: "anthropic",
  DAILY_GEN_QUOTA: "unlimited",
  DAILY_ASSIST_QUOTA: "unlimited",
  RATE_LIMIT_PER_USER_MIN: "unlimited",
  MAX_ACTIVE_JOBS: "unlimited",
  FX_USD_JSON: JSON.stringify({ eur: 1 }),
  CREDITS_COST_JSON: JSON.stringify({ qcm: 2 }),
  AI_BUDGET_MARGIN: "0.6",
  AI_JOB_COST_USD_JSON: JSON.stringify({ qcm: 4, exam: 2, prepare: 0.15, assist: 0.1 }),
  SPEND_CAP_PER_USER_USD: "10",
  SPEND_CAP_PER_USER_FLOOR_USD: "8",
  SPEND_CAP_USD: "1000",
  SPEND_CAP_BASE_USD: "20",
  CORTEX_OWNER_USER_ID: "boss",
};
Object.assign(process.env, ENV);

import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";

let reserve: typeof import("../lib/billing/reserve");
let credits: typeof import("../lib/billing/credits");
let revenue: typeof import("../lib/billing/revenue");
let usage: typeof import("../lib/billing/usage");
let limits: typeof import("../lib/billing/limits");
let authRun: typeof import("../db/auth-store").authRun;
let nowStr: typeof import("../db/q").nowStr;

before(async () => {
  delete process.env.CORTEX_USER;
  delete process.env.AI_BUDGET_FREE_USD;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
  reserve = await import("../lib/billing/reserve");
  credits = await import("../lib/billing/credits");
  revenue = await import("../lib/billing/revenue");
  usage = await import("../lib/billing/usage");
  limits = await import("../lib/billing/limits");
  ({ authRun } = await import("../db/auth-store"));
  ({ nowStr } = await import("../db/q"));
});
beforeEach(() => usage.resetSpendCache());
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres?.();
  for (const k of Object.keys(ENV)) delete process.env[k];
});

const inMl = <T,>(user: string, fn: () => Promise<T>) => runWithUser(user, () => runWithCourse("ml", fn));
let n = 0;
const QCM_TARGET = JSON.stringify({ count: 20, openCount: 3 });

/** Dépense IA réelle du jour (llm_usage). */
async function spend(user: string, usd: number) {
  await authRun(
    `INSERT INTO llm_usage (user_id, course, provider, model, tokens_in, tokens_out, cost_usd, estimated, job_id, call_site, created_at)
     VALUES (?, 'ml', 'anthropic', 'claude-sonnet-5', 1000, 500, ?, 0, '1', 'qcm:generateBatch', ?)`,
    user, usd, nowStr(),
  );
}
/** Compte payant (revenu large : le budget lié au revenu ne borne pas) et crédits achetés. */
async function payingAccount(user: string, creditsN = 50) {
  await revenue.recordPayment({ sourceId: `cs_${user}`, kind: "pack", paymentIntent: `pi_${user}`, userId: user, currency: "eur", amountCents: 100_000, feeCents: 0 });
  await credits.addTransaction(user, creditsN * 100, "purchase", `purchase:${user}`);
}

/** Ce que voit l'étudiant ne nomme ni dollars ni variables d'environnement. */
function assertStudentSafe(text: string) {
  assert.doesNotMatch(text, /\$|USD|dollar/i, `pas de montant en dollars : ${text}`);
  assert.doesNotMatch(text, /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/, `pas de nom de variable : ${text}`);
}

test("trois chemins, un verdict : route et réservation gardent la langue de l’app, MCP rend le même code en anglais", async () => {
  await payingAccount("alice");
  await spend("alice", 9); // 9 + 4 attendus pour un QCM > 10 : refusé avant le lancement
  const cost = (await import("../lib/jobs")).costForJob("qcm", QCM_TARGET);

  const shown = await inMl("alice", () => limits.getUsageLimits(undefined, { spec: limits.jobSpec("qcm", cost), kind: "qcm", label: "examen QCM", plural: "examens QCM" }));
  assert.equal(shown.check?.allowed, false);
  assert.equal(shown.check?.blockedBy, "daily_compute");
  assert.ok(shown.check?.blockedUntil, "la remise à zéro est donnée");
  assert.equal(shown.generations.qcm.allowed, false);

  const { preflightGeneration } = await import("../lib/preflight");
  const route = await inMl("alice", () => preflightGeneration("qcm", QCM_TARGET));
  const reserved = await inMl("alice", () => reserve.reserveGeneration({ bucket: "gen", kind: "qcm", costCenti: cost, ref: `job:alice:ml:${++n}`, jobSlot: true }));
  const { confirmCost } = await import("../lib/mcp/confirm");
  const { runWithLocale } = await import("../lib/i18n/context");
  const english = await runWithLocale("en", () => inMl("alice", () => preflightGeneration("qcm", QCM_TARGET)));
  const mcp = await runWithLocale("en", () => inMl("alice", () => confirmCost(
    { principal: { userId: "alice" } as never, era: "legacy" as never, mcpReq: {} as never, tool: "generate_mock_exam" },
    { bucket: "gen", kind: "qcm", costCenti: cost, summary: "MCQ exam." }, {}, undefined,
  ).then(() => null, (e: import("../lib/mcp/tool").ToolError) => e)));

  assert.ok(route && english && !reserved.ok && mcp, "les trois chemins refusent");
  assert.equal(route.error, shown.check?.reason);
  assert.equal(!reserved.ok && reserved.error, shown.check?.reason);
  assert.equal(mcp.message, english.error);
  assert.equal(mcp.appCode, english.code);
  assert.equal(route.status, !reserved.ok ? reserved.status : -1);
  assertStudentSafe(route.error);
  assert.equal(await credits.getBalanceCenti("alice"), 5000, "rien n'est débité");

  // Une aide (0,1 attendu) passe encore : la limite est projetée, pas un seuil global.
  const assist = await inMl("alice", () => reserve.reserveGeneration({ bucket: "assist", kind: "drill", costCenti: 10, ref: `assist:alice:${++n}` }));
  assert.equal(assist.ok, true);
});

test("réservation atomique : deux lancements simultanés près du calcul du jour, un seul passe ; la place libérée rouvre", async () => {
  await payingAccount("bob");
  await spend("bob", 3); // 3 + 4 = 7 passe ; 3 + 4 + 4 = 11 ne passe pas
  const refs = [`job:bob:ml:${++n}`, `job:bob:ml:${++n}`];
  const both = await Promise.all(refs.map((ref) =>
    inMl("bob", () => reserve.reserveGeneration({ bucket: "gen", kind: "qcm", costCenti: 200, ref, jobSlot: true }))));
  assert.equal(both.filter((r) => r.ok).length, 1, "un seul des deux lancements simultanés passe");
  const refused = both.find((r) => !r.ok);
  assert.ok(refused && !refused.ok && /calcul du jour/i.test(refused.error));
  assert.equal(await credits.getBalanceCenti("bob"), 4800, "un seul débit");

  // L'affichage tient compte du job en cours : plus aucun QCM aujourd'hui.
  const shown = await inMl("bob", () => limits.getUsageLimits());
  assert.equal(shown.generations.qcm.allowed, false);
  assert.equal(shown.generations.qcm.remaining, 0);

  // Le job fini libère sa réservation : son coût réel est maintenant dans llm_usage.
  const done = refs[both.findIndex((r) => r.ok)];
  await reserve.releaseJobSlot("bob", done);
  await spend("bob", 2);
  usage.resetSpendCache();
  const again = await inMl("bob", () => reserve.reserveGeneration({ bucket: "gen", kind: "qcm", costCenti: 200, ref: `job:bob:ml:${++n}`, jobSlot: true }));
  assert.equal(again.ok, true, "5 dépensés + 4 attendus = 9 : la réservation libérée rouvre le lancement");
});

test("propriétaire : exempté du plafond du jour par compte, toujours soumis au fusible global", async () => {
  await spend("boss", 40); // bien au-delà des 10 par compte
  const ok = await inMl("boss", () => reserve.reserveGeneration({ bucket: "gen", kind: "qcm", costCenti: 200, ref: `job:boss:ml:${++n}`, jobSlot: true }));
  assert.equal(ok.ok, true);
  await inMl("boss", () => usage.assertSpendCap("anthropic"));
  const shown = await inMl("boss", () => limits.getUsageLimits());
  assert.equal(shown.owner, true);
  assert.ok(!shown.limits.some((l) => l.key === "daily_compute"), "aucun calcul du jour affiché pour le propriétaire");
  assert.equal(shown.generations.qcm.allowed, true);

  process.env.SPEND_CAP_USD = "50";
  try {
    usage.resetSpendCache();
    const capped = await inMl("boss", () => reserve.reserveGeneration({ bucket: "gen", kind: "qcm", costCenti: 200, ref: `job:boss:ml:${++n}`, jobSlot: true }));
    assert.equal(capped.ok, false, "fusible global : le propriétaire aussi");
    assert.ok(!capped.ok && /tout Cortex/.test(capped.error));
  } finally {
    process.env.SPEND_CAP_USD = ENV.SPEND_CAP_USD;
  }
});

test("GET /api/usage : chiffres, remises à zéro, jamais de dollars ni de nom de variable", async () => {
  await payingAccount("carol");
  await spend("carol", 9.5);
  const { NextRequest } = await import("next/server");
  const { GET } = await import("../app/api/usage/route");
  const res = await runWithUser("carol", () => GET(new NextRequest(`http://localhost/api/usage?kind=qcm&target=${encodeURIComponent(QCM_TARGET)}`, { headers: { "x-cortex-user": "carol" } })));
  assert.equal(res.status, 200);
  const body = await res.json() as import("../lib/billing/limits-text").UsageLimits;
  assertStudentSafe(JSON.stringify(body));
  assert.equal(body.check?.allowed, false);
  assert.equal(body.check?.blockedBy, "daily_compute");
  const compute = body.limits.find((l) => l.key === "daily_compute");
  assert.equal(compute?.unit, "%");
  assert.match(compute?.resetAt ?? "", /T00:00:00(\.000)?Z$/, "remise à zéro à minuit UTC");
  const creditsLine = body.limits.find((l) => l.key === "credits");
  assert.equal(creditsLine?.remaining, 50);
  assert.equal(body.generations.check.allowed, true);

  const bad = await runWithUser("carol", () => GET(new NextRequest("http://localhost/api/usage?kind=nimporte", { headers: { "x-cortex-user": "carol" } })));
  assert.equal(bad.status, 400);
});

test("phrases : il reste, remise à 0 à l'heure de Lausanne, après celle-ci", async () => {
  const { remainingLine, afterLine, formatReset } = await import("../lib/billing/limits-text");
  const u = { kind: "qcm", label: "examen QCM (20 questions)", plural: "examens QCM", costCredits: 2, remaining: 3, limitedBy: "daily_generations" as const,
    resetAt: "2026-11-16T00:00:00.000Z", allowed: true, reason: null, blockedBy: null, blockedUntil: null, status: null };
  // 23:30 UTC = 00:30 à Lausanne : la remise de minuit UTC tombe le même jour, à 01:00.
  assert.equal(remainingLine(u, "2026-11-15 23:30:00"), "Il te reste 3 examens QCM aujourd'hui · remise à 0 à 01:00");
  assert.equal(afterLine(u, "2026-11-15 23:30:00"), "Après celle-ci, il te restera 2 examens QCM aujourd'hui (remise à 0 à 01:00)");
  assert.equal(remainingLine({ ...u, remaining: 1 }, "2026-11-15 10:00:00"), "Il te reste 1 examen QCM aujourd'hui · remise à 0 demain à 01:00");
  assert.equal(formatReset("2026-12-01T00:00:00.000Z", "2026-11-15 10:00:00"), "le 1er décembre");
  assert.equal(remainingLine({ ...u, remaining: null }, "2026-11-15 10:00:00"), null);
  assert.equal(remainingLine({ ...u, limitedBy: "credits" }, "2026-11-15 10:00:00"), "Il te reste 3 examens QCM avec ton solde");
});
