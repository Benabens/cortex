/**
 * SURVEILLANCE (25/11/2026) — tout échec qui touche un étudiant remonte à Sentry, UNE fois, avec
 * des étiquettes stables (failure, job_type, course_kind, error_code, user_hash) et un
 * regroupement par code d'erreur, jamais par message variable. Aucune donnée personnelle : ni
 * e-mail, ni identifiant de compte, ni contenu de cours. Exemple à ne plus revivre : la #209, un
 * catch vide qui masquait les questions ouvertes perdues.
 *
 * Transport factice : initErrorTracking({ load }) remplace le SDK ; chaque événement est gardé
 * avec son contexte (tags, level, fingerprint) puis passé par le nettoyage (beforeSend) réel.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-sentry-echecs-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.AUTH_ENABLED = "0";
process.env.AI_BUDGET_MARGIN = "unlimited";
process.env.CREDITS_COST_JSON = JSON.stringify({ exam: 6, qcm: 4, exercise: 1, "lab-exercise": 1, blueprint: 1, format: 1, prepare: 2, assist: 0.3 });

/** Un événement tel que Sentry le recevrait : contexte de capture + événement nettoyé. */
type Captured = { e: unknown; tags: Record<string, string>; level?: string; fingerprint?: string[]; sent: unknown };
const captured: Captured[] = [];
let beforeSend: ((event: Record<string, unknown>) => unknown) | null = null;

const STUDENT = "etudiante.fictive@exemple.test";

before(async () => {
  for (const k of ["BILLING_ENABLED", "DB_DRIVER", "CORTEX_USER"]) delete process.env[k];
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
  process.env.SENTRY_DSN = "https://exemple@o0.ingest.sentry.io/1";
  const { initErrorTracking } = await import("../lib/observability");
  await initErrorTracking({
    load: async () => ({
      init: (opts: Record<string, unknown>) => { beforeSend = opts.beforeSend as typeof beforeSend; },
      captureException: (e: unknown, hint?: Record<string, unknown>) => {
        const tags = (hint?.tags ?? {}) as Record<string, string>;
        const err = e instanceof Error ? e : new Error(String(e));
        const event = { message: undefined, tags, exception: { values: [{ type: err.name, value: err.message }] }, user: { email: STUDENT } };
        captured.push({ e, tags, level: hint?.level as string | undefined, fingerprint: hint?.fingerprint as string[] | undefined, sent: beforeSend ? beforeSend(event) : event });
      },
      flush: async () => true,
    }),
  });
});
beforeEach(async () => {
  captured.length = 0;
  const { resetErrorTrackingThrottleForTests } = await import("../lib/observability");
  resetErrorTrackingThrottleForTests();
});
after(async () => {
  const { resetErrorTrackingForTests } = await import("../lib/observability");
  resetErrorTrackingForTests();
  for (const k of ["CORTEX_DATA_DIR", "AUTH_ENABLED", "SENTRY_DSN", "BILLING_ENABLED", "AI_BUDGET_MARGIN", "CREDITS_COST_JSON", "SIGNUP_FREE_CREDITS"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Rien de personnel dans ce que Sentry reçoit : ni l'e-mail, ni l'identifiant, ni le texte passé. */
function assertNoPersonalData(c: Captured, ...secrets: string[]) {
  const wire = JSON.stringify({ tags: c.tags, fingerprint: c.fingerprint, sent: c.sent, message: (c.e as Error)?.message });
  for (const s of [STUDENT, ...secrets]) assert.ok(!wire.includes(s), `« ${s} » ne doit pas partir chez Sentry : ${wire}`);
}

test("reportFailure : un seul événement, étiquettes stables, regroupé par code et non par message", async () => {
  const { reportFailure } = await import("../lib/failure-report");
  const { runWithUser } = await import("../db/context");
  await runWithUser(STUDENT, async () => {
    reportFailure({ failure: "job_failed", level: "error", jobType: "qcm", code: "job_failed", courseKind: "generic" });
    reportFailure({ failure: "job_failed", level: "error", jobType: "qcm", code: "job_failed", courseKind: "generic" });
  });
  assert.equal(captured.length, 2, "pas de bridage sur les échecs de job : chaque étudiant touché compte");
  const [a, b] = captured;
  assert.equal(a.level, "error");
  assert.deepEqual(a.fingerprint, ["cortex", "job_failed", "qcm", "job_failed"]);
  assert.deepEqual(a.fingerprint, b.fingerprint);
  assert.equal(a.tags.failure, "job_failed");
  assert.equal(a.tags.job_type, "qcm");
  assert.equal(a.tags.course_kind, "generic");
  assert.equal(a.tags.error_code, "job_failed");
  assert.match(a.tags.user_hash, /^[0-9a-f]{12}$/);
  assert.equal(a.tags.user_hash, b.tags.user_hash, "même étudiant, même empreinte : Sentry compte les étudiants touchés");
  assertNoPersonalData(a);
});

test("user_hash : deux comptes, deux empreintes ; l'empreinte ne se recalcule pas sans le secret du serveur", async () => {
  const { userHash } = await import("../lib/failure-report");
  assert.notEqual(userHash("a@exemple.test"), userHash("b@exemple.test"));
  const crypto = await import("node:crypto");
  const naive = crypto.createHash("sha256").update("a@exemple.test").digest("hex").slice(0, 12);
  assert.notEqual(userHash("a@exemple.test"), naive, "une empreinte nue se retrouve en hachant une liste d'e-mails");
});

/**
 * Un job du cours « algo » (semé par défaut), débité de son prix (facturation active). Worker vivant
 * (ce process, battement frais) sauf `deadWorker` : la réconciliation ne doit toucher que celui-là.
 */
async function reservedJob(user: string, type: "exam" | "qcm", status = "running", deadWorker = false): Promise<number> {
  const jobs = await import("../lib/jobs");
  const credits = await import("../lib/billing/credits");
  const reserve = await import("../lib/billing/reserve");
  const { q, nowStr } = await import("../db/q");
  await jobs.ensureJobsSchema();
  const id = await q.insert(
    `INSERT INTO jobs (type, target, status, current_step, progress, pid, heartbeat_at, attempts, max_attempts, created_at, updated_at) VALUES (?,?,?,'Génération…',30,?,?,2,2,?,?)`,
    type, null, status, deadWorker ? 999999 : process.pid, deadWorker ? null : nowStr(), nowStr(-180_000), nowStr(-180_000),
  );
  const ref = credits.jobRef(user, "algo", id);
  await q.run(`UPDATE jobs SET credit_ref = ? WHERE id = ?`, ref, id);
  await reserve.reserveGeneration({ bucket: "gen", kind: type, ref });
  return id;
}

async function asStudent<T>(fn: () => Promise<T>): Promise<T> {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  return runWithUser(STUDENT, () => runWithCourse("algo", fn));
}

function billing() {
  process.env.BILLING_ENABLED = "1";
  process.env.SIGNUP_FREE_CREDITS = "40";
}

test("job en échec définitif : UN événement job_failed (code de l'erreur, crédits rendus), sans le message du job", async () => {
  billing();
  await asStudent(async () => {
    const jobs = await import("../lib/jobs");
    const { userError } = await import("../lib/i18n/user-error");
    const id = await reservedJob(STUDENT, "qcm");
    const secret = "Énoncé du cours : la preuve du théorème de Bézout";
    const r = await jobs.recordJobFailure(id, `Échec : ${secret}`, userError("job_failed"));
    assert.equal(r, "failed");
    assert.equal((await jobs.getJob(id))?.status, "error");
    assert.equal(captured.length, 1, JSON.stringify(captured.map((c) => c.tags)));
    const [c] = captured;
    assert.equal(c.level, "error");
    assert.equal(c.tags.failure, "job_failed");
    assert.equal(c.tags.job_type, "qcm");
    assert.equal(c.tags.error_code, "job_failed");
    assert.equal(c.tags.credits_back, "yes", "le remboursement automatique se lit dans l'événement");
    assert.deepEqual(c.fingerprint, ["cortex", "job_failed", "qcm", "job_failed"]);
    assertNoPersonalData(c, secret, "Bézout", "algo");
  });
});

test("job annulé par l'étudiant pendant l'échec : rien n'est signalé (ce n'est pas une panne)", async () => {
  billing();
  await asStudent(async () => {
    const jobs = await import("../lib/jobs");
    const { userError } = await import("../lib/i18n/user-error");
    const id = await reservedJob(STUDENT, "exam", "canceled");
    assert.equal(await jobs.recordJobFailure(id, "Échec", userError("job_failed")), "skipped");
    assert.equal(captured.length, 0);
  });
});

test("job abandonné par la réconciliation (worker mort, tentatives épuisées) : UN événement job_abandoned", async () => {
  billing();
  await asStudent(async () => {
    const jobs = await import("../lib/jobs");
    await reservedJob(STUDENT, "exam", "running", true);
    await jobs.reconcileStaleJobs();
    const abandoned = captured.filter((c) => c.tags.failure === "job_abandoned");
    assert.equal(abandoned.length, 1, JSON.stringify(captured.map((c) => c.tags)));
    assert.equal(captured.length, 1, "le remboursement qui suit ne fait pas un second événement");
    assert.equal(abandoned[0].tags.job_type, "exam");
    assert.equal(abandoned[0].tags.error_code, "job_worker_lost");
    assert.equal(abandoned[0].tags.credits_back, "yes");
    assertNoPersonalData(abandoned[0], "algo");
  });
});

test("examen livré incomplet : UN événement exam_incomplete (avertissement), regroupé sans le nombre de questions", async () => {
  billing();
  await asStudent(async () => {
    const jobs = await import("../lib/jobs");
    const id = await reservedJob(STUDENT, "qcm");
    const s = await jobs.settleShortfallDetail({ id, type: "qcm" }, 7, 10);
    assert.ok(s && s.backCenti > 0, "le manque est remboursé (comportement inchangé)");
    assert.equal(captured.length, 1, JSON.stringify(captured.map((c) => c.tags)));
    assert.equal(captured[0].level, "warning");
    assert.equal(captured[0].tags.failure, "exam_incomplete");
    assert.equal(captured[0].tags.credits_back, "yes");
    assert.deepEqual(captured[0].fingerprint, ["cortex", "exam_incomplete", "qcm", "exam_incomplete"]);
  });
});

test("remboursement dû qui lève (base indisponible) : UN événement refund_failed, et l'appelant reçoit 0 comme avant", async () => {
  billing();
  await asStudent(async () => {
    const credits = await import("../lib/billing/credits");
    const { authRun } = await import("../db/auth-store");
    const id = await reservedJob(STUDENT, "exam");
    const ref = credits.jobRef(STUDENT, "algo", id);
    captured.length = 0;
    await authRun(`ALTER TABLE credit_transactions RENAME TO credit_transactions_ailleurs`);
    try {
      assert.equal(await credits.refundGeneration("exam", ref, STUDENT), 0);
    } finally {
      await authRun(`ALTER TABLE credit_transactions_ailleurs RENAME TO credit_transactions`);
    }
    assert.equal(captured.length, 1, JSON.stringify(captured.map((c) => c.tags)));
    assert.equal(captured[0].level, "error");
    assert.equal(captured[0].tags.failure, "refund_failed");
    assert.equal(captured[0].tags.job_type, "exam");
    assertNoPersonalData(captured[0], ref);
  });
});

test("PDF non compilé même après le repli : UN événement pdf_failed, l'erreur du job reste celle d'avant", async () => {
  await asStudent(async () => {
    const jobs = await import("../lib/jobs");
    const id = await reservedJob(STUDENT, "exam");
    captured.length = 0;
    await jobs.recordPdfFailure(id, "exam", "! Undefined control sequence \\subq{énoncé secret}");
    const j = await jobs.getJob(id);
    assert.match(j?.error ?? "", /^Compilation LaTeX échouée — PDF indisponible, repli HTML lisible\. Détail : /);
    assert.equal(j?.errorInfo?.code, "job_pdf_failed");
    assert.equal(captured.length, 1);
    assert.equal(captured[0].level, "warning");
    assert.equal(captured[0].tags.failure, "pdf_failed");
    assert.equal(captured[0].tags.error_code, "job_pdf_failed");
    assertNoPersonalData(captured[0], "énoncé secret");
  });
});

test("ingestion : fichiers illisibles → UN événement ingest_files_failed ; un PDF chiffré seul (fichier de l'étudiant) n'en fait pas", async () => {
  const { reportIngestProblems } = await import("../lib/failure-report");
  await asStudent(async () => {
    reportIngestProblems({ files: [
      { path: "data/u/x/algo/content/cours-secret.pdf", status: "unreadable", items: 0 },
      { path: "data/u/x/algo/content/td.pdf", status: "unreadable", items: 0 },
      { path: "data/u/x/algo/content/ok.pdf", status: "indexed", items: 12 },
    ] }, "prepare");
    reportIngestProblems({ files: [{ path: "a.pdf", status: "encrypted", items: 0 }] }, "ingest");
    reportIngestProblems(null, "ingest");
  });
  assert.equal(captured.length, 1, JSON.stringify(captured.map((c) => c.tags)));
  assert.equal(captured[0].level, "warning");
  assert.equal(captured[0].tags.failure, "ingest_files_failed");
  assert.equal(captured[0].tags.error_code, "unreadable");
  assert.equal(captured[0].tags.job_type, "prepare");
  assert.equal(captured[0].tags.files_unreadable, "2");
  assertNoPersonalData(captured[0], "cours-secret", "algo");
});

test("corrigé non compilé (énoncé en PDF) : UN événement answer_key_pdf_failed", async () => {
  const { reportAnswerKeyPdfFailure } = await import("../lib/failure-report");
  // Le chemin réel compile avec tectonic (absent en CI) : la garde vérifie l'appel depuis les trois sites.
  const sources = ["lib/exam-latex.ts", "lib/qcm-latex.ts"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8"));
  assert.equal(sources.join("\n").split("reportAnswerKeyPdfFailure()").length - 1, 3);
  const { setCurrentJob, clearCurrentJob } = await import("../lib/billing/usage-context");
  setCurrentJob(3, "exam");
  try { reportAnswerKeyPdfFailure(); } finally { clearCurrentJob(); }
  assert.equal(captured.length, 1);
  assert.equal(captured[0].tags.failure, "answer_key_pdf_failed");
  assert.equal(captured[0].tags.job_type, "exam");
});

test("refus voulu (plafond de dépense, cours sans support) : job_failed en avertissement, pas en erreur", async () => {
  const { recordJobFailure } = await import("../lib/jobs");
  const id = await reservedJob(STUDENT, "qcm");
  await asStudent(() => recordJobFailure(id, "Plafond atteint", { code: "llm_reservation_spend_cap" }));
  assert.equal(captured.length, 1);
  assert.equal(captured[0].level, "warning");
  assert.equal(captured[0].tags.error_code, "llm_reservation_spend_cap");
});

test("étape de contrôle sautée en cours de job (relecture en échec) : UN avertissement generation_degraded, cause = code du modèle", async () => {
  const { reportDegraded } = await import("../lib/failure-report");
  const { LlmError } = await import("../lib/llm/types");
  const { setCurrentJob, clearCurrentJob } = await import("../lib/billing/usage-context");
  setCurrentJob(5, "qcm");
  try {
    await asStudent(async () => reportDegraded("qcm_final_review", new LlmError("529 overloaded : prompt du cours algo", "OVERLOADED", true)));
  } finally { clearCurrentJob(); }
  assert.equal(captured.length, 1, JSON.stringify(captured.map((c) => c.tags)));
  const [c] = captured;
  assert.equal(c.level, "warning");
  assert.equal(c.tags.failure, "generation_degraded");
  assert.equal(c.tags.error_code, "qcm_final_review");
  assert.equal(c.tags.cause, "overloaded");
  assert.deepEqual(c.fingerprint, ["cortex", "generation_degraded", "qcm", "qcm_final_review"]);
  assertNoPersonalData(c, "prompt du cours", "algo");
  // Les sites d'appel : relectures et vérifications qui laissaient passer l'échec sans un mot.
  const src = ["lib/qcm.ts", "lib/exam.ts", "lib/check-solution.ts"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
  for (const step of ["qcm_final_review", "qcm_distractors", "exam_verify", "check_second_review"]) assert.match(src, new RegExp(`reportDegraded\\("${step}"`));
});

test("hors contexte de cours (webhook de paiement) : course_kind « unknown », pas le cours par défaut", async () => {
  const { reportFailure } = await import("../lib/failure-report");
  const saved = process.env.CORTEX_COURSE;
  delete process.env.CORTEX_COURSE;
  try {
    reportFailure({ failure: "refund_failed", level: "error", code: "refund_exception", jobType: "assist_drill", extra: { area: "forge" } });
  } finally { if (saved !== undefined) process.env.CORTEX_COURSE = saved; }
  assert.equal(captured[0].tags.course_kind, "unknown");
  assert.equal(captured[0].tags.job_type, "drill", "même vocabulaire que le job");
  assert.equal(captured[0].tags.area, "billing", "une étiquette en plus n'écrase pas les étiquettes de base");
});
