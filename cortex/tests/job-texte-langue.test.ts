/**
 * LE SUIVI D'UN JOB DANS LA LANGUE DE CELUI QUI LE LIT (audit 5, reste de #14 et #17). L'interface
 * est traduite (#150), mais l'étape, le temps restant et l'erreur d'un job sont des phrases
 * françaises écrites par le worker, renvoyées telles quelles : un étudiant anglophone suivait
 * son examen avec « En file : environ 12 min une fois lancé » et lisait son échec en français.
 * Un lecteur français garde les phrases détaillées du worker, sauf pendant la génération : l'interface
 * montre alors l'étape lisible (lib/job-stage), le connecteur garde la phrase du moteur.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";

import { runWithCourse } from "../db/client";
import { q } from "../db/q";

const COURSE = "ml";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL"]) delete process.env[k];
});

const inCourse = <T>(fn: () => Promise<T>) => runWithCourse(COURSE, fn);

/** Mots et accents qui trahissent une phrase française. */
const FRENCH = /[àâçéèêëîïôûùü]|\b(en file|le|la|les|du|des|une|crédits?|rendus?|relance|lancé)\b/i;

async function readJob(id: number, lang: "en" | "fr"): Promise<{ currentStep: string | null; eta: string | null; error: string | null }> {
  const route = await import("../app/api/jobs/[id]/route");
  const req = new NextRequest(`http://localhost/api/jobs/${id}?course=${COURSE}`, {
    headers: { "accept-language": lang === "en" ? "en-US,en;q=0.9" : "fr-CH,fr;q=0.9" },
  });
  const res = await route.GET(req, { params: Promise.resolve({ id: String(id) }) });
  assert.equal(res.status, 200);
  return await res.json();
}

test("job en file : étape et temps restant en anglais pour un lecteur anglais, inchangés en français", async () => {
  const jobs = await import("../lib/jobs");
  const id = await inCourse(() => jobs.createJob("qcm"));

  const en = await readJob(id, "en");
  assert.ok(en.currentStep && !FRENCH.test(en.currentStep), `étape : ${en.currentStep}`);
  assert.ok(en.eta && !FRENCH.test(en.eta), `temps restant : ${en.eta}`);

  const fr = await readJob(id, "fr");
  assert.equal(fr.currentStep, "En file…");
  assert.match(fr.eta ?? "", /^En file : environ \d+ min une fois lancé/);
});

test("job abandonné par la réconciliation (worker mort) : erreur en anglais, phrase française d'origine en français", async () => {
  const jobs = await import("../lib/jobs");
  const id = await inCourse(async () => {
    const id = await jobs.createJob("exam");
    // Jamais démarré (aucun PID) depuis plus de 2 min : la réconciliation le met en erreur.
    await q.run(`UPDATE jobs SET status = 'running', updated_at = ?, created_at = ? WHERE id = ?`, "2026-11-15 00:00:00", "2026-11-15 00:00:00", id);
    await jobs.reconcileStaleJobs();
    return id;
  });

  const en = await readJob(id, "en");
  assert.ok(en.error && !FRENCH.test(en.error), `erreur : ${en.error}`);
  assert.match(en.error ?? "", /credit reservation|interrupted/i);
  assert.ok(en.currentStep === null || !FRENCH.test(en.currentStep), `étape : ${en.currentStep}`);

  const fr = await readJob(id, "fr");
  assert.match(fr.error ?? "", /Reprise annulée|Worker interrompu/);
});

test("échec du modèle dans le worker : code de la cause enveloppée, crédits rendus dans la langue du lecteur", async () => {
  const jobs = await import("../lib/jobs");
  const { jobErrorOf } = await import("../lib/i18n/job-text");
  const { LlmError } = await import("../lib/llm");
  // Ce que lève le générateur QCM quand le fournisseur ne répond pas (lib/qcm.ts).
  const thrown = new Error("Aucun QCM généré : le fournisseur d'IA est surchargé ou injoignable en ce moment.", { cause: new LlmError("529 overloaded", "OVERLOADED", true) });
  const info = jobErrorOf(thrown);
  assert.equal(info.code, "llm_provider_unreachable");

  // Ce qu'écrit fail() (scripts/run-job.ts) : la phrase du journal, puis le remboursement.
  const id = await inCourse(async () => {
    const id = await jobs.createJob("qcm");
    await jobs.setJob(id, { status: "error", error: `${thrown.message} — 4 crédits rendus.`, errorInfo: { ...info, creditsBackCenti: 400 } });
    return id;
  });
  const en = await readJob(id, "en");
  assert.equal(en.error, "The AI provider is overloaded or unreachable after several retries. Try again in a few minutes (4 credits returned).");
  const fr = await readJob(id, "fr");
  assert.equal(fr.error, `${thrown.message} — 4 crédits rendus.`);
});

test("une exception sans code : message générique en anglais, jamais la phrase française", async () => {
  const { jobErrorOf } = await import("../lib/i18n/job-text");
  assert.equal(jobErrorOf(new Error("Corpus vide : rien à lire")).code, "job_failed");
  // Un code système n'est pas une erreur du modèle : jamais « The AI engine failed unexpectedly ».
  assert.equal(jobErrorOf(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })).code, "job_failed");
  assert.equal(jobErrorOf(Object.assign(new Error("x"), { userError: { code: "job_qcm_all_dropped", params: { dropped: 12 } } })).code, "job_qcm_all_dropped");
});

test("examen livré incomplet : « Done ⚠ » et le manque en anglais, la phrase d'origine en français", async () => {
  const jobs = await import("../lib/jobs");
  const id = await inCourse(async () => {
    const id = await jobs.createJob("exam");
    const shortfall = await jobs.settleShortfallDetail({ id, type: "exam" }, 18, 20);
    await jobs.setJob(id, { status: "done", progress: 100, ...jobs.doneStep(shortfall) });
    return id;
  });
  const en = await readJob(id, "en");
  assert.equal(en.currentStep, "Done ⚠ 2 questions of 20 couldn’t be generated");
  const fr = await readJob(id, "fr");
  assert.equal(fr.currentStep, "Terminé ⚠ 2 questions sur 20 n'ont pas pu être générées");
});

test("une étape écrite sans forme sans langue efface la précédente : jamais un « Done » resté d'avant", async () => {
  const jobs = await import("../lib/jobs");
  const id = await inCourse(async () => {
    const id = await jobs.createJob("exam");
    await jobs.setJob(id, { status: "running", currentStep: "Reprise…", stepInfo: { key: "resumed", attempt: 2, max: 2 } });
    await jobs.setJob(id, { currentStep: "Lot 3/4…", progress: 40 });
    return id;
  });
  const en = await readJob(id, "en");
  assert.equal(en.currentStep, "Generating the mock exam…");
});

test("reprise automatique, temps restant sans historique : phrases anglaises", async () => {
  const { localizeJob } = await import("../lib/i18n/job-text");
  const job = { type: "qcm", status: "queued", currentStep: "Worker interrompu, reprise automatique (tentative 2/2), progression conservée.", error: null, stepInfo: { key: "resumed" as const, attempt: 2, max: 2 } };
  const eta = { remainingMs: 300_000, late: false, basis: "default" as const, label: "≈ 5 min restantes (reprise) (estimation sans historique)", kind: "resumed" as const, minutes: 5, lowMs: 180_000, highMs: 540_000 };
  assert.deepEqual(localizeJob(job, eta, "en"), {
    currentStep: "Worker interrupted, resuming automatically (attempt 2/2), progress kept.",
    error: null,
    eta: "≈ 5 min left (resumed) (estimate without history)",
  });
  assert.deepEqual(localizeJob(job, eta, "fr"), { currentStep: job.currentStep, error: null, eta: eta.label });
});

test("pendant la génération : l'étape lisible dans les deux langues, la phrase du moteur pour le connecteur", async () => {
  const jobs = await import("../lib/jobs");
  const engine = "Génération de 4 QCM (architecte · moules + idées fausses)…";
  const id = await inCourse(async () => {
    const id = await jobs.createJob("qcm");
    await jobs.setJob(id, { status: "running", currentStep: "8/20 QCM construits + vérifiés…", progress: 40 });
    await jobs.setJob(id, { currentStep: engine });
    return id;
  });
  const fr = await readJob(id, "fr");
  assert.equal(fr.currentStep, "Rédaction des questions · 8/20 QCM prêts");
  const en = await readJob(id, "en");
  assert.equal(en.currentStep, "Writing the questions · 8/20 MCQs ready");
  const { localizeJob } = await import("../lib/i18n/job-text");
  const job = (await inCourse(() => jobs.getJob(id)))!;
  assert.equal(localizeJob(job, null, "en", { fallback: "raw" }).currentStep, engine);
  assert.equal(localizeJob(job, null, "fr", { fallback: "raw" }).currentStep, engine);
  // Fini : la phrase de fin, plus l'étape.
  await inCourse(() => jobs.setJob(id, { status: "done", progress: 100, ...jobs.doneStep(null) }));
  assert.equal((await readJob(id, "fr")).currentStep, "Terminé ✓");
});
