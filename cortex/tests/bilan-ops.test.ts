/**
 * BILAN D'EXPLOITATION PAR E-MAIL (25/11/2026) — calculé par Cortex lui-même, en SQL, sans aucun
 * appel au modèle. Chaque jour à 8 h (Zurich), le mail ne part que si un seuil est franchi sur
 * les dernières 24 h ; le lundi, il part toujours avec le bilan de la semaine. Une seule fois par
 * jour, même si la tâche tourne deux fois (deux process, redémarrage). Agrégats tous comptes
 * confondus : ni e-mail d'étudiant, ni identifiant, ni nom de cours dans le mail.
 *
 * Données fictives : deux comptes, deux cours, des jobs posés à des dates fixes autour d'une
 * horloge injectée (mardi 24/11/2026 9 h 30 à Zurich, lundi 23/11 pour le bilan).
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bilan-ops-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.AUTH_ENABLED = "1";
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "0";
process.env.OPS_DIGEST_ENABLED = "1";
process.env.OPS_DIGEST_TO = "proprietaire@exemple.test";
process.env.CREDIT_NET_USD = "0.64";
process.env.JOB_SPEND_CAP_USD_PER_CREDIT = "0.9";
// Aucun appel au modèle possible : un appel échouerait (et laisserait une trace dans llm_usage).
process.env.LLM_PROVIDER = "claude-code";
process.env.CORTEX_CLAUDE_BIN = "/usr/bin/false";
delete process.env.CORTEX_USER;

const ALICE = "alice.fictive@exemple.test";
const BOB = "bob.fictif@exemple.test";
const TUESDAY = new Date("2026-11-24T08:30:00Z"); // 9 h 30 à Zurich
const MONDAY = new Date("2026-11-23T08:30:00Z");

type Mail = { to: string; subject: string; text: string; html?: string; idempotencyKey?: string };
const sent: Mail[] = [];
const send = async (m: Mail) => { sent.push(m); return { ok: true as const }; };

const at = (base: Date, minutesBefore: number) => new Date(base.getTime() - minutesBefore * 60_000).toISOString().slice(0, 19).replace("T", " ");

async function ownedCourse(id: string, owner: string) {
  const { insertCourse } = await import("../db/courses-store");
  await insertCourse({
    id, owner_user_id: owner, name: `Cours secret ${id}`, short: id.toUpperCase(), code: null, exam_name: "Final", exam_kind: "Final", university: null,
    university_lines: "[]", faculty: null, teachers: "[]", language: "fr", profile_id: null, duration_min: 120, exam_date: null,
    db_file: null, refs_rel: null, exams_rel: null, uploads_rel: null, content_rel: null, created_at: "2026-09-01 00:00:00",
  });
}

type JobSpec = {
  owner: string; course: string; type: string; status: string;
  /** Fin du job, en minutes avant l'horloge. */
  endedMinAgo: number; minutes: number;
  /** Crédits débités (centièmes) et coût du modèle ($). */
  billedCenti?: number; costUsd?: number; errorCode?: string; incomplete?: boolean; base?: Date;
};

/** Pose un job dans la base de son cours, son débit au registre et ses appels au modèle (llm_usage). */
async function job(s: JobSpec): Promise<number> {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { authRun } = await import("../db/auth-store");
  const jobs = await import("../lib/jobs");
  const base = s.base ?? TUESDAY;
  const end = at(base, s.endedMinAgo);
  const start = at(base, s.endedMinAgo + s.minutes);
  const id = await runWithUser(s.owner, () => runWithCourse(s.course, async () => {
    await jobs.ensureJobsSchema();
    return q.insert(
      `INSERT INTO jobs (type, target, status, current_step, progress, error_json, step_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      s.type, null, s.status, "Étape secrète du cours", s.status === "done" ? 100 : 40,
      s.errorCode ? JSON.stringify({ code: s.errorCode }) : null,
      s.incomplete ? JSON.stringify({ key: "doneIncomplete", missing: 2, requested: 10, backCenti: 360 }) : null,
      start, end,
    );
  }));
  const ref = `job:${s.owner}:${s.course}:${id}`;
  await runWithUser(s.owner, () => runWithCourse(s.course, () => q.run(`UPDATE jobs SET credit_ref = ? WHERE id = ?`, ref, id)));
  if (s.billedCenti) {
    await authRun(
      `INSERT INTO credit_transactions (user_id, delta, reason, ref, unit, created_at) VALUES (?,?,?,?,'centi',?)`,
      s.owner, -s.billedCenti, `génération ${s.type}`, ref, start,
    );
  }
  if (s.costUsd) {
    await authRun(
      `INSERT INTO llm_usage (user_id, course, provider, model, cost_usd, job_id, call_site, credit_ref, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      s.owner, s.course, "anthropic", "claude-opus-5-5", s.costUsd, String(id), `${s.type}:generate`, ref, start,
    );
  }
  return id;
}

async function refund(owner: string, refOf: string, centi: number, minAgo: number, base = TUESDAY) {
  const { authRun } = await import("../db/auth-store");
  await authRun(
    `INSERT INTO credit_transactions (user_id, delta, reason, ref, unit, share_milli, created_at) VALUES (?,?,?,?,'centi',1000,?)`,
    owner, centi, "remboursement qcm", `refund:${refOf}`, at(base, minAgo),
  );
}

async function wipe() {
  const { authRun } = await import("../db/auth-store");
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  for (const [owner, course] of [[ALICE, "reseaux-fictif"], [BOB, "proba-fictif"]]) {
    await runWithUser(owner, () => runWithCourse(course, () => q.run(`DELETE FROM jobs`)));
  }
  await authRun(`DELETE FROM credit_transactions`);
  await authRun(`DELETE FROM llm_usage`);
  await authRun(`DELETE FROM app_meta WHERE key LIKE 'ops_digest:%'`);
}

before(async () => {
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  const credits = await import("../lib/billing/credits");
  const { recordUsage } = await import("../lib/billing/usage");
  await ensureCoursesLoaded();
  await ownedCourse("reseaux-fictif", ALICE);
  await ownedCourse("proba-fictif", BOB);
  await reloadCourses();
  // Tables du registre et de l'usage, colonnes ajoutées comprises.
  await credits.getBalance(ALICE);
  await recordUsage({ provider: "anthropic", model: "claude-opus-5-5", tokensIn: 1, tokensOut: 1 }).catch(() => {});
});
beforeEach(async () => {
  sent.length = 0;
  await wipe();
  const { setStatfsForTests } = await import("../lib/storage-quota");
  setStatfsForTests(() => ({ free: 80, total: 100 }));
});
after(async () => {
  const { setStatfsForTests } = await import("../lib/storage-quota");
  setStatfsForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Huit jobs sains (mardi, dernières 24 h) : 10 min, livrés, marge positive. */
async function calmDay(base = TUESDAY) {
  for (let i = 0; i < 4; i++) await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "done", endedMinAgo: 60 + i * 30, minutes: 10, billedCenti: 1800, costUsd: 2, base });
  for (let i = 0; i < 4; i++) await job({ owner: BOB, course: "proba-fictif", type: "exam", status: "done", endedMinAgo: 90 + i * 30, minutes: 12, billedCenti: 3000, costUsd: 5, base });
}

async function run(now: Date) {
  const { runOpsDigest } = await import("../lib/ops-digest");
  return runOpsDigest({ now, send });
}

test("mardi calme : aucun seuil franchi → aucun e-mail", async () => {
  await calmDay();
  const r = await run(TUESDAY);
  assert.equal(r.status, "quiet", JSON.stringify(r));
  assert.equal(sent.length, 0);
});

test("désactivé sans OPS_DIGEST_ENABLED=1 (invariant : rien d'imposé par défaut)", async () => {
  delete process.env.OPS_DIGEST_ENABLED;
  try {
    await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "error", endedMinAgo: 30, minutes: 5, errorCode: "job_failed" });
    assert.equal((await run(TUESDAY)).status, "disabled");
    assert.equal(sent.length, 0);
  } finally {
    process.env.OPS_DIGEST_ENABLED = "1";
  }
});

test("avant 8 h à Zurich : rien ne part encore", async () => {
  await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "error", endedMinAgo: 30, minutes: 5, errorCode: "job_failed" });
  const early = new Date("2026-11-24T06:30:00Z"); // 7 h 30 à Zurich
  assert.equal((await run(early)).status, "too_early");
  assert.equal(sent.length, 0);
});

test("taux d'échec > 5 % sur au moins 5 jobs → alerte, sujet « Cortex — 1 alerte »", async () => {
  await calmDay();
  await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "error", endedMinAgo: 30, minutes: 5, errorCode: "llm_overloaded" });
  const r = await run(TUESDAY);
  assert.equal(r.status, "sent", JSON.stringify(r));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "proprietaire@exemple.test");
  assert.equal(sent[0].subject, "Cortex — 1 alerte");
  assert.match(sent[0].text, /1 échec sur 9 jobs \(11 %\)/);
  assert.match(sent[0].text, /llm_overloaded/, "le code d'erreur le plus fréquent est cité");
});

test("un échec sur 3 jobs seulement : sous le minimum de 5 jobs, pas d'alerte de taux", async () => {
  await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "done", endedMinAgo: 60, minutes: 10, billedCenti: 1800, costUsd: 2 });
  await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "done", endedMinAgo: 90, minutes: 10, billedCenti: 1800, costUsd: 2 });
  await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "error", endedMinAgo: 30, minutes: 5, errorCode: "job_failed" });
  assert.equal((await run(TUESDAY)).status, "quiet");
});

test("seuil réglable : OPS_ALERT_FAIL_MIN_JOBS=3 fait partir l'alerte du même jour", async () => {
  process.env.OPS_ALERT_FAIL_MIN_JOBS = "3";
  try {
    await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "done", endedMinAgo: 60, minutes: 10 });
    await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "done", endedMinAgo: 90, minutes: 10 });
    await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "error", endedMinAgo: 30, minutes: 5, errorCode: "job_failed" });
    assert.equal((await run(TUESDAY)).status, "sent");
  } finally {
    delete process.env.OPS_ALERT_FAIL_MIN_JOBS;
  }
});

test("au moins un remboursement automatique en 24 h → alerte", async () => {
  await calmDay();
  await refund(ALICE, "job:x:y:1", 1800, 120);
  await refund(ALICE, "job:x:y:2", 1800, 60 * 30); // hier soir, hors fenêtre
  const r = await run(TUESDAY);
  assert.equal(r.status, "sent");
  assert.match(sent[0].text, /1 remboursement automatique \(18 crédits\)/);
});

test("un job plus de 2 fois plus long que la médiane de son type → alerte", async () => {
  await calmDay();
  await job({ owner: BOB, course: "proba-fictif", type: "qcm", status: "done", endedMinAgo: 20, minutes: 45, billedCenti: 1800, costUsd: 2 });
  await run(TUESDAY);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /qcm : 1 job de 45 min, médiane 10 min/);
});

test("coût du modèle d'un job au-dessus de 80 % de son plafond (crédits × JOB_SPEND_CAP_USD_PER_CREDIT) → alerte", async () => {
  await calmDay();
  // 18 crédits × 0,9 $ = 16,2 $ de plafond ; 80 % = 12,96 $.
  await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "done", endedMinAgo: 40, minutes: 11, billedCenti: 1800, costUsd: 14.1 });
  await run(TUESDAY);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /qcm : 14,10 \$ pour un plafond de 16,20 \$ \(87 %\)/);
});

test("job bloqué en cours depuis plus d'une heure → alerte", async () => {
  await calmDay();
  await job({ owner: ALICE, course: "reseaux-fictif", type: "exam", status: "running", endedMinAgo: 95, minutes: 5 });
  await run(TUESDAY);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /1 job sans avancer depuis plus de 60 min \(exam\)/);
});

test("job en compilation sans battement depuis plus d'une heure → alerte ; un job vivant (battement récent) n'en fait pas", async () => {
  await calmDay();
  await job({ owner: ALICE, course: "reseaux-fictif", type: "exam", status: "compiling", endedMinAgo: 95, minutes: 5 });
  const alive = await job({ owner: BOB, course: "proba-fictif", type: "exam", status: "running", endedMinAgo: 95, minutes: 5 });
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  await runWithUser(BOB, () => runWithCourse("proba-fictif", () => q.run(`UPDATE jobs SET heartbeat_at = ? WHERE id = ?`, at(TUESDAY, 1), alive)));
  await run(TUESDAY);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /1 job sans avancer depuis plus de 60 min \(exam\)/);
});

test("le taux d'échec ne compte que les générations : une ingestion ratée n'en fait pas une alerte", async () => {
  await calmDay();
  await job({ owner: ALICE, course: "reseaux-fictif", type: "ingest", status: "error", endedMinAgo: 30, minutes: 1, errorCode: "job_failed" });
  assert.equal((await run(TUESDAY)).status, "quiet");
});

test("volume presque plein (moins de 20 % libres) → alerte", async () => {
  const { setStatfsForTests } = await import("../lib/storage-quota");
  setStatfsForTests(() => ({ free: 12, total: 100 }));
  await calmDay();
  await run(TUESDAY);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Volume : 12 % libres/);
});

test("idempotence : la tâche qui tourne deux fois (deux process en même temps, puis une relance) n'envoie qu'un e-mail", async () => {
  await calmDay();
  await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "error", endedMinAgo: 30, minutes: 5, errorCode: "job_failed" });
  const { runOpsDigest } = await import("../lib/ops-digest");
  const [a, b] = await Promise.all([runOpsDigest({ now: TUESDAY, send }), runOpsDigest({ now: TUESDAY, send })]);
  const later = await runOpsDigest({ now: new Date(TUESDAY.getTime() + 3 * 3600_000), send });
  assert.equal(sent.length, 1, JSON.stringify([a.status, b.status, later.status]));
  assert.ok([a.status, b.status].includes("sent"));
  assert.equal(later.status, "already_done");
  // Un jour calme est clos aussi : pas de recalcul toutes les dix minutes.
  await wipe();
  sent.length = 0;
  await calmDay();
  assert.equal((await runOpsDigest({ now: TUESDAY, send })).status, "quiet");
  assert.equal((await runOpsDigest({ now: TUESDAY, send })).status, "already_done");
});

test("refus passager du fournisseur d'e-mails (503) : le jour est rendu, la tâche suivante réessaie", async () => {
  await calmDay();
  await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "error", endedMinAgo: 30, minutes: 5, errorCode: "job_failed" });
  const { runOpsDigest } = await import("../lib/ops-digest");
  const refused = await runOpsDigest({ now: TUESDAY, send: async () => ({ ok: false, reason: "HTTP 503", status: 503 }) });
  assert.equal(refused.status, "failed");
  assert.equal((await runOpsDigest({ now: TUESDAY, send })).status, "sent");
  assert.equal(sent.length, 1);
});

test("refus durable (422 : domaine non vérifié) : le jour est clos, pas un essai toutes les dix minutes", async () => {
  await calmDay();
  await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "error", endedMinAgo: 30, minutes: 5, errorCode: "job_failed" });
  const { runOpsDigest } = await import("../lib/ops-digest");
  assert.equal((await runOpsDigest({ now: TUESDAY, send: async () => ({ ok: false, reason: "HTTP 422", status: 422 }) })).status, "failed");
  assert.equal((await runOpsDigest({ now: TUESDAY, send })).status, "already_done");
  assert.equal(sent.length, 0);
});

test("envoi incertain (Resend sans réponse) : la réclamation reste, pas de second envoi tout de suite, même clé d'idempotence à la reprise", async () => {
  await calmDay();
  await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "error", endedMinAgo: 30, minutes: 5, errorCode: "job_failed" });
  const { runOpsDigest } = await import("../lib/ops-digest");
  const keys: Array<string | undefined> = [];
  const r = await runOpsDigest({ now: TUESDAY, send: async (m) => { keys.push(m.idempotencyKey); return { ok: false, reason: "délai dépassé", uncertain: true }; } });
  assert.equal(r.status, "failed");
  assert.equal((await runOpsDigest({ now: TUESDAY, send })).status, "busy", "un autre passage ne renvoie pas pendant le quart d'heure");
  assert.equal(sent.length, 0);
  assert.match(keys[0] ?? "", /^ops_digest:2026-11-24:[0-9a-f-]{36}$/);
});

test("lundi : le bilan de la semaine part toujours, avec volumes, échecs, coûts, marges, durées, étudiants touchés et pistes", async () => {
  // Semaine du 16 au 23/11 : jobs livrés, un échec chez Bob, un examen incomplet chez Alice, des drills à perte.
  // Rien dans les dernières 24 h : le bilan seul, sans alerte du jour.
  for (let i = 0; i < 4; i++) await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "done", endedMinAgo: 60 * 24 * (i + 1) + 60, minutes: 10 + i, billedCenti: 1800, costUsd: 2 + i, base: MONDAY });
  const incomplete = await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "done", endedMinAgo: 60 * 30, minutes: 12, billedCenti: 1800, costUsd: 3, incomplete: true, base: MONDAY });
  await refund(ALICE, `job:${ALICE}:reseaux-fictif:${incomplete}`, 360, 60 * 30, MONDAY);
  await job({ owner: BOB, course: "proba-fictif", type: "exam", status: "done", endedMinAgo: 60 * 50, minutes: 20, billedCenti: 3000, costUsd: 5, base: MONDAY });
  await job({ owner: BOB, course: "proba-fictif", type: "exam", status: "error", endedMinAgo: 60 * 70, minutes: 8, costUsd: 1.5, errorCode: "job_failed", base: MONDAY });
  for (let i = 0; i < 3; i++) await job({ owner: BOB, course: "proba-fictif", type: "drill", status: "done", endedMinAgo: 60 * (30 + i), minutes: 2, billedCenti: 50, costUsd: 0.62, base: MONDAY });
  // Avant la semaine : ignoré.
  await job({ owner: BOB, course: "proba-fictif", type: "exam", status: "error", endedMinAgo: 60 * 24 * 9, minutes: 8, errorCode: "job_failed", base: MONDAY });

  const r = await run(MONDAY);
  assert.equal(r.status, "sent", JSON.stringify(r));
  assert.equal(sent.length, 1);
  const { subject, text, html } = sent[0];
  assert.equal(subject, "Cortex — bilan semaine 47");
  // Volumes et échecs par type
  assert.match(text, /qcm\s+5 jobs\s+5 livrés\s+0 échec/);
  assert.match(text, /exam\s+2 jobs\s+1 livré\s+1 échec/);
  assert.match(text, /drill\s+3 jobs\s+3 livrés\s+0 échec/);
  // Coût moyen, p95, max, facturé et marge par type (drill : 0,62 $ pour 0,5 crédit ≈ 0,32 $)
  assert.match(text, /drill\s.*0,62 \$ moy\.\s+0,62 \$ p95\s+0,62 \$ max\s+0,32 \$ facturé\s+−0,30 \$ marge/);
  // Durées médiane et p95
  assert.match(text, /qcm\s.*médiane 12 min\s+p95 13 min/);
  // Étudiants touchés : Bob (échec) et Alice (examen incomplet)
  assert.match(text, /Étudiants touchés par une erreur : 2/);
  // Pistes d'optimisation, par règles
  assert.match(text, /drill : coût moyen 0,62 \$ pour 0,5 crédit ≈ 0,32 \$ facturé, marge négative/);
  assert.match(text, /Bilan des 7 derniers jours \(16\.11 09:30 → 23\.11 09:30\)/);
  assert.match(text, /https:\/\/sentry\.io\//);
  assert.match(text, /https:\/\/railway\.com\//);
  assert.ok(html && html.includes("<table"), "chiffres en tableau dans la version HTML");
});

test("lundi sans aucun job : le bilan part quand même (on sait que la tâche tourne)", async () => {
  const r = await run(MONDAY);
  assert.equal(r.status, "sent");
  assert.equal(sent[0].subject, "Cortex — bilan semaine 47");
  assert.match(sent[0].text, /Aucun job cette semaine/);
});

test("lundi avec des alertes : le sujet le dit aussi", async () => {
  await job({ owner: ALICE, course: "reseaux-fictif", type: "exam", status: "running", endedMinAgo: 95, minutes: 5, base: MONDAY });
  await run(MONDAY);
  assert.equal(sent[0].subject, "Cortex — bilan semaine 47 · 1 alerte");
});

test("aucune donnée personnelle : ni e-mail d'étudiant, ni nom ou identifiant de cours, ni étape de job", async () => {
  await calmDay(MONDAY);
  await job({ owner: ALICE, course: "reseaux-fictif", type: "qcm", status: "error", endedMinAgo: 30, minutes: 5, errorCode: "job_failed", base: MONDAY });
  await refund(ALICE, `job:${ALICE}:reseaux-fictif:1`, 1800, 20, MONDAY);
  await run(MONDAY);
  const wire = JSON.stringify(sent);
  for (const s of [ALICE, BOB, "alice", "bob", "reseaux-fictif", "proba-fictif", "Cours secret", "Étape secrète"]) {
    assert.ok(!wire.includes(s), `« ${s} » dans le mail`);
  }
});

test("aucun appel au modèle : CORTEX_CLAUDE_BIN=/usr/bin/false, aucune ligne d'usage ajoutée, aucun compteur LLM", async () => {
  await calmDay(MONDAY);
  const { authGet } = await import("../db/auth-store");
  const before = (await authGet<{ n: number }>(`SELECT count(*) n FROM llm_usage`))!.n;
  await run(MONDAY);
  assert.equal(sent.length, 1);
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM llm_usage`))!.n, before);
  const { snapshot } = await import("../lib/metrics");
  assert.equal(snapshot().counters.cortex_llm_calls_total, undefined, "aucun appel LLM tenté");
});

test("envoi de test à la main (scripts/ops-digest.ts --test) : part même un jour calme, sans clore le jour", async () => {
  await calmDay();
  const { runOpsDigest } = await import("../lib/ops-digest");
  const t = await runOpsDigest({ now: TUESDAY, send, test: true });
  assert.equal(t.status, "sent");
  assert.match(sent[0].subject, /^\[test\] Cortex — /);
  assert.equal((await runOpsDigest({ now: TUESDAY, send })).status, "quiet", "le passage du jour a toujours lieu");
});
