/**
 * Worker détaché d'un job de génération (cf. lib/jobs.ts).
 * Lancé par /api/exams/generate via spawn(detached).unref() → survit à la requête HTTP
 * et au rechargement de page. Écrit l'avancement dans la table `jobs`.
 * Lancer : tsx scripts/run-job.ts <jobId>
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { enterCourse, sqlite } from "../db/client";
import { claudeBinPath } from "../lib/claude-code";
import { generateExamViaClaudeCode, generateTargetedExercise } from "../lib/exam";
import { texAvailable } from "../lib/exam-latex";
import { getJob, logJob, setJob } from "../lib/jobs";
import { generateLabExercise } from "../lib/labs";
import { analyzeBlueprint } from "../lib/program";

const jobId = Number(process.argv[2]);
const COURSE = process.argv[3];
// Cours du job (argv[3] ; CORTEX_COURSE est aussi posé par startWorker) → ouvre la BONNE DB.
enterCourse(COURSE);

function fail(msg: string): never {
  try { setJob(jobId, { status: "error", error: msg }); logJob(jobId, "ERREUR : " + msg); } catch {}
  process.exit(1);
}

/** Job d'INGESTION (Phase 1) : (re)construit le corpus du cours, en important un dossier si fourni. */
async function runIngestJob(target: string | null): Promise<void> {
  setJob(jobId, { status: "running", pid: process.pid, currentStep: "Ingestion…", progress: 5 });
  const tsxLocal = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const args = ["scripts/ingest.ts", "--course", COURSE ?? "cs-202"];
  if (target) args.push("--from", target);
  logJob(jobId, `Lancement : ingest --course=${COURSE}${target ? ` --from ${target}` : ""}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(tsxLocal, args, { cwd: process.cwd(), env: { ...process.env, CORTEX_COURSE: COURSE } });
    let last = "";
    const onData = (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        const t = line.trim();
        if (!t) continue;
        last = t;
        logJob(jobId, t);
        if (/Import du dossier/.test(t)) setJob(jobId, { currentStep: "Import du dossier…", progress: 20 });
        else if (/Nettoyage/.test(t)) setJob(jobId, { currentStep: "Indexation…", progress: 45 });
        else if (/vocabulaire/.test(t)) setJob(jobId, { currentStep: "Vocabulaire…", progress: 80 });
        else if (/Compris pour/.test(t)) setJob(jobId, { currentStep: "Récap…", progress: 95 });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(last || `ingest a quitté (code ${code})`))));
  });
}

async function main() {
  if (!jobId) { console.error("usage: run-job <jobId> <course>"); process.exit(1); }
  const job = getJob(jobId);
  if (!job) { console.error("job introuvable: " + jobId); process.exit(1); }
  if (job.status === "canceled") process.exit(0);

  if (job.type === "ingest") {
    try {
      await runIngestJob(job.target);
      setJob(jobId, { status: "done", progress: 100, currentStep: "Ingestion terminée ✓" });
      logJob(jobId, "Ingestion terminée ✓");
      process.exit(0);
    } catch (e) {
      fail((e as Error)?.message || String(e));
    }
    return;
  }

  // V7 — (re)détection du format d'examen depuis les annales (après upload de finals).
  if (job.type === "format") {
    setJob(jobId, { status: "running", pid: process.pid, currentStep: "Détection du format…", progress: 4 });
    if (!claudeBinPath()) fail("Claude Code introuvable.");
    try {
      const { detectFormat } = await import("../lib/format");
      const onStep = (s: string, p: number) => {
        const j = getJob(jobId);
        if (j?.status === "canceled") { logJob(jobId, "Annulé."); process.exit(0); }
        setJob(jobId, { currentStep: s, progress: p, status: p >= 100 ? "done" : "running" });
        logJob(jobId, s);
      };
      const f = await detectFormat({ onStep });
      setJob(jobId, { status: "done", progress: 100, currentStep: `Format détecté : ${(f.format_summary || "").slice(0, 60)} ✓` });
      process.exit(0);
    } catch (e) { fail((e as Error)?.message || String(e)); }
    return;
  }

  // V6 — examen QCM (cours générique au format QCM, ex. ML/CS-233).
  if (job.type === "qcm") {
    setJob(jobId, { status: "running", pid: process.pid, currentStep: "Architecte QCM…", progress: 4 });
    logJob(jobId, `Worker démarré (PID ${process.pid})`);
    if (!claudeBinPath()) fail("Claude Code (binaire « claude ») introuvable.");
    try {
      const { generateQcmExam } = await import("../lib/qcm");
      const count = job.target ? Number(JSON.parse(job.target).count) || undefined : undefined;
      const onStep = (s: string, p: number) => {
        const j = getJob(jobId);
        if (j?.status === "canceled") { logJob(jobId, "Annulé."); process.exit(0); }
        setJob(jobId, { currentStep: s, progress: p, status: p >= 100 ? "done" : "running" });
        logJob(jobId, s);
      };
      const res = await generateQcmExam({ count, onStep });
      setJob(jobId, { status: "done", progress: 100, resultId: res.id, resultPath: `/mock/${res.id}`, currentStep: `Mock QCM #${res.id} — ${res.count} QCM (${res.verified} vérifiés) ✓` });
      logJob(jobId, `Mock QCM #${res.id} prêt → /mock/${res.id}`);
      process.exit(0);
    } catch (e) {
      fail((e as Error)?.message || String(e));
    }
    return;
  }

  // PHASE 1 — analyse de blueprint (taxonomie typée + pondérée via Max + vision).
  if (job.type === "blueprint") {
    setJob(jobId, { status: "running", pid: process.pid, currentStep: "Analyse du programme…", progress: 4 });
    logJob(jobId, `Worker démarré (PID ${process.pid})`);
    if (!claudeBinPath()) fail("Claude Code (binaire « claude ») introuvable. Lance « claude » une fois pour te connecter à ton Max.");
    const n = (sqlite.prepare("SELECT count(*) n FROM items").get() as { n: number } | undefined)?.n ?? 0;
    if (!n) fail("Corpus non ingéré. Lance « npm run ingest » d'abord.");
    try {
      const onStep = (s: string, p: number) => {
        const j = getJob(jobId);
        if (j?.status === "canceled") { logJob(jobId, "Annulé."); process.exit(0); }
        setJob(jobId, { currentStep: s, progress: p, status: p >= 100 ? "done" : "running" });
        logJob(jobId, s);
      };
      const res = await analyzeBlueprint({ onStep });
      setJob(jobId, { status: "done", progress: 100, resultId: res.count, currentStep: `Taxonomie : ${res.count} types ✓` });
      logJob(jobId, `Blueprint prêt → ${res.count} types d'exercices identifiés.`);
      process.exit(0);
    } catch (e) {
      fail((e as Error)?.message || String(e));
    }
    return;
  }

  setJob(jobId, { status: "running", pid: process.pid, currentStep: "Pré-vérifications…", progress: 2 });
  logJob(jobId, `Worker démarré (PID ${process.pid})`);

  // ---- Pré-checks (Phase 4) : échec clair AVANT 20 min de travail ----
  if (!claudeBinPath()) fail("Claude Code (binaire « claude ») introuvable. Installe-le et lance « claude » une fois pour te connecter à ton Max.");
  const items = (sqlite.prepare("SELECT count(*) n FROM items").get() as { n: number } | undefined)?.n ?? 0;
  if (!items) fail("Corpus non ingéré. Lance « npm run ingest » d'abord.");
  if (!texAvailable()) logJob(jobId, "⚠ tectonic/pdflatex absent → repli HTML. Installe tectonic (brew install tectonic) pour le vrai PDF.");
  logJob(jobId, "Pré-checks OK");

  const onStep = (s: string, p: number) => {
    const j = getJob(jobId);
    if (j?.status === "canceled") { logJob(jobId, "Annulé."); process.exit(0); }
    const status = p >= 100 ? "done" : p >= 92 ? "compiling" : p >= 45 ? "verifying" : "running";
    setJob(jobId, { currentStep: s, progress: p, status });
    logJob(jobId, s);
  };

  try {
    const res =
      job.type === "exercise"
        ? await generateTargetedExercise(job.target ?? "", { onStep })
        : job.type === "lab-exercise"
          ? await generateLabExercise(job.target ?? "", { onStep })
          : await generateExamViaClaudeCode({ onStep });
    if (res.texError) {
      // le résultat existe (HTML lisible) mais le PDF a échoué → erreur LaTeX gardée pour debug
      setJob(jobId, { error: `Compilation LaTeX échouée — PDF indisponible, repli HTML lisible. Détail : ${res.texError.slice(0, 500)}` });
      logJob(jobId, `⚠ Erreur LaTeX : ${res.texError.slice(0, 300)}`);
    }
    setJob(jobId, { status: "done", progress: 100, resultPath: res.url, resultId: res.id, currentStep: "Terminé ✓" });
    logJob(jobId, `${job.type === "exercise" ? "Exercice" : job.type === "lab-exercise" ? "Exercice Labs" : "Examen"} #${res.id} prêt → ${res.url}`);
    process.exit(0);
  } catch (e) {
    fail((e as Error)?.message || String(e));
  }
}

main();
