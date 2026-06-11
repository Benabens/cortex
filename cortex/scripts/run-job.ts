/**
 * Worker détaché d'un job de génération (cf. lib/jobs.ts).
 * Lancé par /api/exams/generate via spawn(detached).unref() → survit à la requête HTTP
 * et au rechargement de page. Écrit l'avancement dans la table `jobs`.
 * Lancer : tsx scripts/run-job.ts <jobId>
 */
import { sqlite } from "../db/client";
import { claudeBinPath } from "../lib/claude-code";
import { generateExamViaClaudeCode, generateTargetedExercise } from "../lib/exam";
import { texAvailable } from "../lib/exam-latex";
import { getJob, logJob, setJob } from "../lib/jobs";

const jobId = Number(process.argv[2]);

function fail(msg: string): never {
  try { setJob(jobId, { status: "error", error: msg }); logJob(jobId, "ERREUR : " + msg); } catch {}
  process.exit(1);
}

async function main() {
  if (!jobId) { console.error("usage: run-job <jobId>"); process.exit(1); }
  const job = getJob(jobId);
  if (!job) { console.error("job introuvable: " + jobId); process.exit(1); }
  if (job.status === "canceled") process.exit(0);

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
    const status = p >= 100 ? "done" : p >= 92 ? "compiling" : p >= 62 ? "verifying" : "running";
    setJob(jobId, { currentStep: s, progress: p, status });
    logJob(jobId, s);
  };

  try {
    const res =
      job.type === "exercise"
        ? await generateTargetedExercise(job.target ?? "", { onStep })
        : await generateExamViaClaudeCode({ onStep });
    setJob(jobId, { status: "done", progress: 100, resultPath: res.url, resultId: res.id, currentStep: "Terminé ✓" });
    logJob(jobId, `${job.type === "exercise" ? "Exercice" : "Examen"} #${res.id} prêt → ${res.url}`);
    process.exit(0);
  } catch (e) {
    fail((e as Error)?.message || String(e));
  }
}

main();
