/**
 * Worker détaché d'un job de génération (cf. lib/jobs.ts).
 * Lancé par /api/exams/generate via spawn(detached).unref() → survit à la requête HTTP
 * et au rechargement de page. Écrit l'avancement dans la table `jobs`.
 * Lancer : tsx scripts/run-job.ts <jobId>
 */
import path from "node:path";
import { enterCourse } from "../db/client";
import { coursePaths, ensureCoursesLoaded } from "../lib/courses";
import { storage } from "../lib/storage";
import { nowStr, q } from "../db/q";
import { llmAvailable, llmUnavailableReason } from "../lib/llm";
import { generateTargetedExercise } from "../lib/exam";
import { generateMockExam } from "../lib/mock-exam";
import { texAvailable } from "../lib/exam-latex";
import { assertJobCourseOwned, costForJob, getJob, heartbeatJob, jobCheckpointStore, logJob, phaseHistory, saveJobCheckpoint, setJob, setJobReport, stepFields } from "../lib/jobs";
import { setCurrentJob } from "../lib/billing/usage-context";
import { generateLabExercise } from "../lib/labs";
import { analyzeBlueprint } from "../lib/program";
import { INGEST_REPORT_ENV, ingestFailureMessage } from "../lib/ingest-report";
import { jobErrorOf, type JobError } from "../lib/i18n/job-text";
import { userError } from "../lib/i18n/user-error";
import { readIngestReport } from "../lib/ingest-report-file";
import { ingestMaxHeapMb, ingestTimeoutMs, spawnBounded } from "../lib/ingest-limits";
import fs from "node:fs";
import os from "node:os";

const jobId = Number(process.argv[2]);
const COURSE = process.argv[3];
// Cours du job (argv[3] ; CORTEX_COURSE est aussi posé par startWorker) → ouvre la BONNE DB.
enterCourse(COURSE);

// battement de cœur : signal de vie même pendant un appel LLM de 10 min
// (le PID seul ne détecte ni worker suspendu ni PID recyclé). unref → ne retient pas le process.
const hb = setInterval(() => { heartbeatJob(jobId).catch(() => {}); }, 30_000);
hb.unref();
heartbeatJob(jobId).catch(() => {});

/**
 * Fin du worker. Le travail tourne dans storage().withLocalDir (cf. le bas du
 * fichier) : en stockage objet, ce que le job a écrit doit partir au seau AVANT
 * la sortie du process. `finish` rend donc la main à withLocalDir, qui envoie
 * puis sort ; le chemin qui l'appelle reste suspendu jusque-là. Hors de cette
 * portée (échec au démarrage), elle sort tout de suite.
 */
let settle: (code: number) => void = (code) => process.exit(code);
function finish(code: number): Promise<never> {
  settle(code);
  return new Promise<never>(() => {});
}

/**
 * `info` : l'erreur sans langue (lib/i18n/job-text) ; `msg` reste la phrase française du journal
 * et du lecteur français.
 */
async function fail(msg: string, info: JobError = userError("job_failed"), opts: { refund?: boolean } = {}): Promise<never> {
  // Annulé entre-temps par l'utilisateur : cancelJob a statué (remboursement compris), on n'écrase rien.
  // « done » aussi : un QCM annulé après livraison est clos par cancelJob avec ce qu'il contenait.
  try { if (["canceled", "done"].includes((await getJob(jobId))?.status ?? "")) process.exit(0); } catch {}
  try {
    // « exam »/« qcm » SEULEMENT : leur progression PAR PHASE (lib/progress) peut afficher
    // un pourcentage très avancé pour un échec immédiat — un lot QCM qui échoue vaut « son
    // unité faite » pour l'ETA (progress.done("QCM", 1) dans lib/qcm.ts), ce qui gonfle
    // l'avancement même à 0 question construite (constat prod 14/11, job 21 HUM-285 :
    // plafond de dépense touché en 2 s, progress_pct affiché à 99). resultId n'est posé QUE
    // par ces deux types (onExamReady) : sans lui, rien de livrable, 0 est le seul pourcentage
    // honnête. Les autres types (ingest, prepare, format, blueprint…) avancent pas à pas
    // (stepFields) : leur pourcentage à l'échec est déjà réel — ne JAMAIS l'écraser (régression
    // du 14/11 : un prepare_course qui échoue après une ingestion réussie retombait à 0 %).
    const current = await getJob(jobId);
    const resetProgress = current && (current.type === "exam" || current.type === "qcm") && !current.resultId;
    await setJob(jobId, { status: "error", error: msg, errorInfo: info, ...(resetProgress ? { progress: 0 } : {}) });
    await logJob(jobId, "ERREUR : " + msg);
  } catch {}
  // Suivi d'erreurs optionnel : un job qui échoue de nuit doit être visible.
  // Étiquettes techniques seulement — le message de job peut citer un cours.
  try {
    const { captureError, flushErrorTracking } = await import("../lib/observability");
    captureError(new Error(msg), { service: "worker", job: String(jobId) });
    // L'envoi est asynchrone et le worker sort juste après : sans attente, l'erreur partait avec lui.
    await flushErrorTracking();
  } catch {}
  // Un job en ÉCHEC n'a rien livré : REMBOURSÉ en entier (idempotent — ref
  // refund:job:…, et seulement si le débit a eu lieu) ; après des appels payants,
  // en crédits offerts, que le budget lié au revenu borne. No-op sans BILLING_ENABLED.
  // Un drill a déjà appliqué la règle des aides (lib/drill-job) : opts.refund = false.
  if (opts.refund !== false) try {
    const { refundJobCredits } = await import("../lib/jobs");
    const { fmtCreditsBack } = await import("../lib/billing/credits");
    const j = await getJob(jobId);
    const back = j ? await refundJobCredits(j, "failed") : 0;
    if (back > 0) await setJob(jobId, { error: `${msg} — ${fmtCreditsBack(back)}.`, errorInfo: { ...info, creditsBackCenti: back } });
  } catch {}
  return finish(1);
}

/** Échec sur une exception : sa phrase pour le journal, son code pour les autres lecteurs. */
function failWith(e: unknown): Promise<never> {
  return fail((e as Error)?.message || String(e), jobErrorOf(e));
}

/** Job d'INGESTION : (re)construit le corpus du cours, en important un dossier si fourni. */
async function runIngestJob(target: string | null): Promise<void> {
  await setJob(jobId, { status: "running", pid: process.pid, currentStep: "Ingestion…", progress: 5 });
  const args = ["scripts/ingest.ts", "--course", COURSE ?? "cs-202"];
  if (target) args.push("--from", target);
  await logJob(jobId, `Lancement : ingest --course=${COURSE}${target ? ` --from ${target}` : ""}`);
  // Le rapport par fichier passe par un fichier temporaire : une ligne de sortie serait coupée
  // entre deux paquets du flux. Rangé sur le job même si l'ingestion échoue ensuite.
  const reportFile = path.join(os.tmpdir(), `cortex-ingest-${process.pid}-${jobId}.json`);
  const { pendingTransit } = await import("../lib/originals/intake");
  const since = nowStr();
  for (let pass = 1; ; pass++) {
    const read = new Set<string>();
    try {
      await runIngestProcess(args, reportFile);
    } finally {
      const report = readIngestReport(reportFile);
      fs.rmSync(reportFile, { force: true });
      if (report) await setJobReport(jobId, report).catch(() => {});
      for (const f of report?.files ?? []) read.add(f.path);
    }
    // Compte gratuit : un fichier arrivé pendant la lecture n'a pas été lu, et son original ne reste
    // pas sur le serveur. Une passe de plus le lit (le dossier importé, lui, l'a déjà été).
    const late = await pendingTransit(since, read);
    if (!late || pass >= 3) break;
    await logJob(jobId, `${late} fichier(s) arrivé(s) pendant l'ingestion : nouvelle lecture`);
    const from = args.indexOf("--from");
    if (from >= 0) args.splice(from, 2);
  }
}

/** Compte gratuit : les annales PDF gardées pour la lecture des pages partent du serveur (lib/originals). */
async function settleAfterPages(): Promise<void> {
  const { settleOriginals } = await import("../lib/originals/intake");
  const r = await settleOriginals({ after: "prepare" }).catch((e) => { console.error("originaux :", e); return null; });
  if (r?.purged) await logJob(jobId, `${r.purged} annale(s) retirée(s) du serveur après lecture des pages (compte gratuit : elles restent sur ton ordinateur)`);
}

function runIngestProcess(args: string[], reportFile: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Borné (audit fuites I9) : tas plafonné, tué au délai, et dans le groupe du worker (une
    // annulation l'atteint). node lui-même, pas le lanceur tsx qui relancerait un second node.
    const timeoutMs = ingestTimeoutMs();
    const { child, done } = spawnBounded(process.execPath, ["--import", "tsx", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, CORTEX_COURSE: COURSE, [INGEST_REPORT_ENV]: reportFile },
      timeoutMs,
      maxHeapMb: ingestMaxHeapMb(),
    });
    const lines: string[] = [];
    // Lignes complètes seulement : un paquet du flux peut couper une ligne en deux. Rangées
    // AVANT toute attente, pour que la sortie entière soit connue à la fermeture.
    const reader = () => {
      let carry = "";
      return {
        take(d: Buffer): string[] {
          const parts = (carry + d.toString()).split("\n");
          carry = parts.pop() ?? "";
          return parts;
        },
        rest: () => carry,
      };
    };
    const out = reader();
    const err = reader();
    const collect = (raw: string[]) => {
      const fresh = raw.map((l) => l.trim()).filter(Boolean);
      lines.push(...fresh);
      return fresh;
    };
    // Gestionnaire ASYNC sur un flux : toute exception y devient un rejet non
    // géré, qui tue le worker en plein travail. Journaliser n'est pas critique —
    // on avale l'échec plutôt que de perdre le job.
    const onLines = async (fresh: string[]) => {
      try {
      for (const t of fresh) {
        await logJob(jobId, t);
        if (/Import du dossier/.test(t)) await setJob(jobId, { currentStep: "Import du dossier…", progress: 20 });
        else if (/Lecture des fichiers/.test(t)) await setJob(jobId, { currentStep: "Lecture des fichiers…", progress: 25 });
        else if (/Nettoyage/.test(t)) await setJob(jobId, { currentStep: "Indexation…", progress: 45 });
        else if (/vocabulaire/.test(t)) await setJob(jobId, { currentStep: "Vocabulaire…", progress: 80 });
        else if (/Compris pour/.test(t)) await setJob(jobId, { currentStep: "Récap…", progress: 95 });
      }
      } catch { /* journal indisponible (base occupée) — le job continue */ }
    };
    child.stdout!.on("data", (d: Buffer) => { void onLines(collect(out.take(d))); });
    child.stderr!.on("data", (d: Buffer) => { void onLines(collect(err.take(d))); });
    child.on("error", reject);
    void done.then(({ code, timedOut }) => {
      void onLines(collect([out.rest(), err.rest()]));
      if (timedOut) reject(new Error(`Import arrêté au bout de ${Math.round(timeoutMs / 60_000)} min : un fichier est sans doute trop lourd ou abîmé. Retire le dernier ajouté, puis relance l'import.`));
      else if (code === 0) resolve();
      else reject(new Error(ingestFailureMessage(lines, code)));
    });
  });
}

async function main() {
  if (!jobId) { console.error("usage: run-job <jobId> <course>"); return finish(1); }
  // AVANT toute requête sur le tenant (getJob l'amorcerait) : le cours doit
  // exister, appartenir à CORTEX_USER et ne pas être en cours de suppression —
  // sinon un worker en retard recréerait un schéma vide pour un cours effacé.
  {
    const { ownsCourse } = await import("../lib/courses");
    const { isCourseDeleting } = await import("../lib/course-deletion");
    const { currentUser } = await import("../db/context");
    if (!ownsCourse(currentUser(), COURSE) || (await isCourseDeleting(currentUser(), COURSE))) {
      console.error(`cours « ${COURSE} » supprimé, en suppression ou inaccessible pour ${currentUser()} : job ${jobId} abandonné`);
      return finish(1);
    }
  }
  const job = await getJob(jobId);
  if (!job) { console.error("job introuvable: " + jobId); return finish(1); }
  if (job.status === "canceled") process.exit(0);
  // Attribution des appels LLM de ce job (colonnes job_id/call_site de llm_usage).
  const reservation = await q.get<{ credit_ref: string | null }>(`SELECT credit_ref FROM jobs WHERE id = ?`, jobId);
  setCurrentJob(jobId, job.type, reservation?.credit_ref ?? null);
  // Le cours doit encore appartenir à l'utilisateur du job (CORTEX_USER) : sinon
  // erreur sans remboursement, et rien n'est généré (cf. lib/jobs).
  if (!(await assertJobCourseOwned(jobId, COURSE))) return finish(1);

  // Format d'examen résolu une fois pour le process : les consignes des profils
  // génériques (langue, style des sujets) le lisent de façon synchrone (lib/exam-format).
  if (job.type !== "ingest") {
    const { resolveExamFormat } = await import("../lib/exam-format");
    await resolveExamFormat().catch(() => null);
  }

  // Aide en job (drill du connecteur) : un appel au modèle, sans fichier du cours (cf. FILELESS).
  if (job.type === "drill") {
    await logJob(jobId, `Worker démarré (PID ${process.pid})`);
    const r = await (await import("../lib/drill-job")).executeDrillJob(jobId);
    if (!r.ok) await fail(r.message, r.info, { refund: false });
    return finish(0);
  }
  if (FILELESS) await fail(`Job ${job.type} lancé sans les fichiers du cours.`);

  if (job.type === "ingest") {
    try {
      await runIngestJob(job.target);
      await setJob(jobId, { status: "done", progress: 100, currentStep: "Ingestion terminée ✓" });
      await logJob(jobId, "Ingestion terminée ✓");
      return finish(0);
    } catch (e) {
      await failWith(e);
    }
    return;
  }

  // ONBOARDING d'un cours DEPUIS L'UI : prepare = ingestion (contenu + annales) → détection
  // du format → blueprint, en UN job avec progression (équivalent de `npm run prepare:course`).
  if (job.type === "prepare") {
    await setJob(jobId, { status: "running", pid: process.pid, currentStep: "Ingestion (contenu + annales)…", progress: 4 });
    try {
      await runIngestJob(null); // purge + ré-indexe content + refs du cours courant
      // Les notes de modalités d'examen semées comme concepts avant la règle sortent du planning.
      await (await import("../lib/schedule")).purgeExamLogisticsConcepts().catch(() => 0);
      const refsN = (await q.get<{ n: number }>(`SELECT count(*) n FROM exam_refs`))?.n ?? 0;
      await setJob(jobId, { currentStep: `Corpus ingéré (refs : ${refsN})`, progress: 34 });
      if (COURSE === "cs-202") {
        await setJob(jobId, { status: "done", progress: 100, currentStep: `Cours prêt ✓ — refs ${refsN} (format/blueprint statiques)` });
        return finish(0);
      }
      if (!llmAvailable()) {
        await setJob(jobId, { status: "done", progress: 100, currentStep: `Ingéré (refs ${refsN}). LLM absent → format+blueprint à relancer une fois connecté.` });
        return finish(0);
      }
      const { detectFormat } = await import("../lib/format");
      await detectFormat({ onStep: async (s, p) => { await setJob(jobId, { currentStep: `Format : ${s}`, progress: 34 + Math.round(p * 0.33) }); } });
      // Le format vient de changer : les consignes du plan (archétypes, langue) suivent le nouveau.
      await (await import("../lib/exam-format")).resolveExamFormat().catch(() => null);
      await setJob(jobId, { currentStep: "Format détecté — index exo-par-exo des finals…", progress: 50 });
      const { rebuildBlueprintFromIndex } = await import("../lib/program");
      const r = await rebuildBlueprintFromIndex({ onStep: async (s, p) => { await setJob(jobId, { currentStep: `Blueprint : ${s}`, progress: 50 + Math.round(p * 0.48) }); } });
      await settleAfterPages();
      await setJob(jobId, { status: "done", progress: 100, currentStep: `Cours prêt ✓ — refs ${refsN}, ${r.exercises} exos indexés (${r.exams} finals) → ${r.types} types` });
      return finish(0);
    } catch (e) { await failWith(e); }
    return;
  }

  // (re)détection du format d'examen depuis les annales (après upload de finals).
  if (job.type === "format") {
    await setJob(jobId, { status: "running", pid: process.pid, currentStep: "Détection du format…", progress: 4 });
    if (!llmAvailable()) await fail(llmUnavailableReason()!, userError("llm_engine_unavailable"));
    try {
      const { detectFormat } = await import("../lib/format");
      const onStep = async (s: string, p: number) => {
        const j = await getJob(jobId);
        if (j?.status === "canceled") { await logJob(jobId, "Annulé."); process.exit(0); }
        await setJob(jobId, stepFields(s, p, (x) => (x >= 100 ? "done" : "running")));
        await logJob(jobId, s);
      };
      const f = await detectFormat({ onStep });
      // Pas de départ ici : l'index exo par exo (préparation, blueprint) relit encore les pages.
      await setJob(jobId, { status: "done", progress: 100, currentStep: `Format détecté : ${(f.format_summary || "").slice(0, 60)} ✓` });
      return finish(0);
    } catch (e) { await failWith(e); }
    return;
  }

  // examen QCM (cours générique au format QCM, ex. ML/CS-233).
  if (job.type === "qcm") {
    await setJob(jobId, { status: "running", pid: process.pid, currentStep: "Architecte QCM…", progress: 4 });
    await logJob(jobId, `Worker démarré (PID ${process.pid})`);
    if (!llmAvailable()) await fail(llmUnavailableReason()!, userError("llm_engine_unavailable"));
    try {
      const { generateQcmExam, qcmExamSummary } = await import("../lib/qcm");
      // composeur : {count, openCount, focus} ; count/openCount peuvent valoir 0 (respectés).
      let count: number | undefined, openCount: number | undefined, focus: string | undefined;
      try {
        const t = job.target ? JSON.parse(job.target) : {};
        if (typeof t.count === "number") count = t.count;
        if (typeof t.openCount === "number") openCount = t.openCount;
        if (typeof t.focus === "string") focus = t.focus;
      } catch {}
      const onStep = async (s: string, p: number) => {
        const j = await getJob(jobId);
        if (j?.status === "canceled") { await logJob(jobId, "Annulé."); process.exit(0); }
        await setJob(jobId, stepFields(s, p, (x) => (x >= 100 ? "done" : "running")));
        await logJob(jobId, s);
      };
      // Livraison progressive : le job pointe vers l'examen dès que ses QCM sont prêts, avec la
      // taille commandée résolue (un échec ensuite ne rend que le manque, lib/jobs refundJobCredits).
      const onExamReady = async (examId: number, order: { requested: number }) => { await setJob(jobId, { resultId: examId, resultPath: `/mock/${examId}`, ordered: order.requested }); };
      // Poids de l'avancement par phase : durées mesurées des derniers examens QCM du cours.
      // Point de reprise : un worker tué (redéploiement, crash) et repris repart de ce qui est acquis.
      const res = await generateQcmExam({ count, openCount, focus, onStep, onExamReady, phaseMs: await phaseHistory("qcm"), checkpoint: jobCheckpointStore(jobId) });
      // Examen incomplet : dit et remboursé au prorata (lib/jobs settleShortfall).
      const { doneStep, settleShortfallDetail } = await import("../lib/jobs");
      const shortfall = await settleShortfallDetail(job, res.count + res.open, res.requested + res.openRequested);
      // PDF non compilé : dit, comme pour l'examen écrit (avant : silencieux, seul le .tex existait).
      if (res.texError) {
        await setJob(jobId, { error: `Compilation LaTeX échouée — PDF indisponible, l'examen reste lisible dans l'app. Détail : ${res.texError.slice(0, 500)}`, errorInfo: userError("job_pdf_failed") });
        await logJob(jobId, `⚠ Erreur LaTeX : ${res.texError.slice(0, 300)}`);
      }
      await setJob(jobId, { status: "done", progress: 100, resultId: res.id, resultPath: `/mock/${res.id}`, ...doneStep(shortfall, `Mock QCM #${res.id} — ${qcmExamSummary(res)}`) });
      await saveJobCheckpoint(jobId, null).catch(() => {}); // job livré : le point de reprise ne sert plus
      await logJob(jobId, `Mock QCM #${res.id} prêt → /mock/${res.id}`);
      return finish(0);
    } catch (e) {
      await failWith(e);
    }
    return;
  }

  // Analyse de blueprint (taxonomie typée + pondérée via le LLM + vision).
  if (job.type === "blueprint") {
    await setJob(jobId, { status: "running", pid: process.pid, currentStep: "Analyse du programme…", progress: 4 });
    await logJob(jobId, `Worker démarré (PID ${process.pid})`);
    if (!llmAvailable()) await fail(llmUnavailableReason()!, userError("llm_engine_unavailable"));
    const n = (await q.get<{ n: number }>("SELECT count(*) n FROM items"))?.n ?? 0;
    if (!n) await fail("Corpus non ingéré. Lance « npm run ingest » d'abord.", userError("job_corpus_missing"));
    try {
      const onStep = async (s: string, p: number) => {
        const j = await getJob(jobId);
        if (j?.status === "canceled") { await logJob(jobId, "Annulé."); process.exit(0); }
        await setJob(jobId, stepFields(s, p, (x) => (x >= 100 ? "done" : "running")));
        await logJob(jobId, s);
      };
      const { rebuildBlueprintFromIndex } = await import("../lib/program");
      const res = await rebuildBlueprintFromIndex({ onStep });
      await settleAfterPages();
      await setJob(jobId, { status: "done", progress: 100, resultId: res.types, currentStep: `Index : ${res.exercises} exos (${res.exams} finals) → ${res.types} types ✓` });
      await logJob(jobId, `Blueprint exhaustif → ${res.exercises} exos indexés, ${res.types} types.`);
      return finish(0);
    } catch (e) {
      await failWith(e);
    }
    return;
  }

  await setJob(jobId, { status: "running", pid: process.pid, currentStep: "Pré-vérifications…", progress: 2 });
  await logJob(jobId, `Worker démarré (PID ${process.pid})`);

  // ---- Pré-checks : échec clair AVANT 20 min de travail ----
  if (!llmAvailable()) await fail(llmUnavailableReason()!, userError("llm_engine_unavailable"));
  const items = (await q.get<{ n: number }>("SELECT count(*) n FROM items"))?.n ?? 0;
  if (!items) await fail("Corpus non ingéré. Lance « npm run ingest » d'abord.", userError("job_corpus_missing"));
  if (!texAvailable()) await logJob(jobId, "⚠ tectonic/pdflatex absent → repli HTML. Installe tectonic (brew install tectonic) pour le vrai PDF.");
  await logJob(jobId, "Pré-checks OK");

  const onStep = async (s: string, p: number) => {
    const j = await getJob(jobId);
    if (j?.status === "canceled") { await logJob(jobId, "Annulé."); process.exit(0); }
    await setJob(jobId, stepFields(s, p, (x) => (x >= 100 ? "done" : x >= 92 ? "compiling" : x >= 45 ? "verifying" : "running")));
    await logJob(jobId, s);
  };

  // composeur : count (questions ou exercices) + « Mets l'accent sur… » (focus thématique) optionnels dans le target 'exam'.
  let examCount: number | undefined, examFocus: string | undefined;
  if (job.type === "exam" && job.target) {
    try {
      const t = JSON.parse(job.target);
      examCount = Number(t.count) || undefined;
      if (typeof t.focus === "string" && t.focus.trim()) examFocus = t.focus.trim();
    } catch {}
  }
  const { targetKind } = await import("../lib/exam-format");
  const examKind = job.type === "exam" ? targetKind(job.target) : null;
  const offServer = await (await import("../lib/course-vision")).offServerRefsNote().catch(() => null);
  if (offServer) await logJob(jobId, offServer);

  try {
    const res =
      job.type === "exercise"
        ? await generateTargetedExercise(job.target ?? "", { onStep })
        : job.type === "lab-exercise"
          ? await generateLabExercise(job.target ?? "", { onStep })
          // Examen blanc : le format du cours choisit le générateur (QCM, exercices, essai…), cf. lib/mock-exam.
          : await generateMockExam({ count: examCount, focus: examFocus, kind: examKind, onStep, jobId, paidCenti: job.type === "exam" ? costForJob("exam", job.target) : undefined, phaseMs: await phaseHistory(job.type), onExamReady: async (examId: number, order?: { requested: number }) => { await setJob(jobId, { resultId: examId, resultPath: `/mock/${examId}`, ordered: order?.requested }); } });
    if (res.texError) {
      // le résultat existe (HTML lisible) mais le PDF a échoué → erreur LaTeX gardée pour debug
      await setJob(jobId, { error: `Compilation LaTeX échouée — PDF indisponible, repli HTML lisible. Détail : ${res.texError.slice(0, 500)}`, errorInfo: userError("job_pdf_failed") });
      await logJob(jobId, `⚠ Erreur LaTeX : ${res.texError.slice(0, 300)}`);
    }
    const { doneStep, settleShortfallDetail } = await import("../lib/jobs");
    // Seul l'examen blanc compte ses questions (MockExamResult) ; exercices et labs n'en ont qu'une.
    const counts = res as { produced?: number; requested?: number };
    const shortfall = counts.produced != null && counts.requested != null
      ? await settleShortfallDetail(job, counts.produced, counts.requested)
      : null;
    await setJob(jobId, { status: "done", progress: 100, resultPath: res.url, resultId: res.id, ...doneStep(shortfall) });
    await logJob(jobId, `${job.type === "exercise" ? "Exercice" : job.type === "lab-exercise" ? "Exercice Labs" : "Examen"} #${res.id} prêt → ${res.url}`);
    return finish(0);
  } catch (e) {
    await failWith(e);
  }
}

// Les cours vivent en base : le worker est un AUTRE process, son cache est vide.
(async () => {
  // Suivi d'erreurs optionnel (SENTRY_DSN) : le worker est un process séparé,
  // il doit s'y abonner lui-même. Sans la variable, rien n'est chargé.
  const { initErrorTracking } = await import("../lib/observability");
  await initErrorTracking({ service: "worker" }).catch(() => {});
})();

/**
 * Drill (CORTEX_JOB_TYPE, posé par startWorker) : il ne lit que la base du cours, jamais ses
 * fichiers. Sans ce raccourci, chaque drill rapatriait tout le cours depuis le seau.
 */
const FILELESS = process.env.CORTEX_JOB_TYPE === "drill";

/**
 * Les fichiers du cours (annales, contenu, examens, captures) sont sur le disque
 * pendant tout le job : rapatriés depuis le seau en stockage objet, puis ce que
 * le job a créé, modifié ou supprimé y est renvoyé — même en cas d'échec, pour
 * qu'une reprise reparte de ses fichiers. Disque local : aucun effet.
 */
async function runWithCourseFiles(): Promise<void> {
  const cp = coursePaths(COURSE);
  let code: number;
  try {
    code = await storage().withLocalDir([cp.refsDir, cp.contentRoot, cp.examsDir, cp.uploadsDir], () => new Promise<number>((resolve) => {
      settle = resolve;
      // main ne se termine que si aucun chemin n'a appelé finish : sortie normale, comme avant.
      main().then(() => resolve(0), failWith);
    }));
  } catch (e) {
    // Le job a fini mais ses fichiers ne sont pas tous dans le seau : ils restent
    // servis depuis ce conteneur, et perdus à son remplacement. À voir tout de suite.
    console.error(`[storage] job ${jobId} : envoi des fichiers au seau impossible : ${(e as Error)?.message ?? e}`);
    try {
      const { captureError, flushErrorTracking } = await import("../lib/observability");
      captureError(e instanceof Error ? e : new Error(String(e)), { service: "worker", job: String(jobId), step: "storage.flush" });
      await flushErrorTracking();
    } catch {}
    code = 1;
  }
  process.exit(code);
}

ensureCoursesLoaded().then(() => FILELESS ? main().then(() => process.exit(0)) : runWithCourseFiles()).catch(failWith);
