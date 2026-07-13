/**
 * Worker détaché d'un job de génération (cf. lib/jobs.ts).
 * Lancé par /api/exams/generate via spawn(detached).unref() → survit à la requête HTTP
 * et au rechargement de page. Écrit l'avancement dans la table `jobs`.
 * Lancer : tsx scripts/run-job.ts <jobId>
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { enterCourse } from "../db/client";
import { q } from "../db/q";
import { llmAvailable, llmUnavailableReason } from "../lib/llm";
import { generateExamViaClaudeCode, generateTargetedExercise } from "../lib/exam";
import { texAvailable } from "../lib/exam-latex";
import { getJob, logJob, setJob } from "../lib/jobs";
import { generateLabExercise } from "../lib/labs";
import { analyzeBlueprint } from "../lib/program";

const jobId = Number(process.argv[2]);
const COURSE = process.argv[3];
// Cours du job (argv[3] ; CORTEX_COURSE est aussi posé par startWorker) → ouvre la BONNE DB.
enterCourse(COURSE);

async function fail(msg: string): Promise<never> {
  try { await setJob(jobId, { status: "error", error: msg }); await logJob(jobId, "ERREUR : " + msg); } catch {}
  process.exit(1);
}

/** Job d'INGESTION (Phase 1) : (re)construit le corpus du cours, en important un dossier si fourni. */
async function runIngestJob(target: string | null): Promise<void> {
  await setJob(jobId, { status: "running", pid: process.pid, currentStep: "Ingestion…", progress: 5 });
  const tsxLocal = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const args = ["scripts/ingest.ts", "--course", COURSE ?? "cs-202"];
  if (target) args.push("--from", target);
  await logJob(jobId, `Lancement : ingest --course=${COURSE}${target ? ` --from ${target}` : ""}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(tsxLocal, args, { cwd: process.cwd(), env: { ...process.env, CORTEX_COURSE: COURSE } });
    let last = "";
    const onData = async (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        const t = line.trim();
        if (!t) continue;
        last = t;
        await logJob(jobId, t);
        if (/Import du dossier/.test(t)) await setJob(jobId, { currentStep: "Import du dossier…", progress: 20 });
        else if (/Nettoyage/.test(t)) await setJob(jobId, { currentStep: "Indexation…", progress: 45 });
        else if (/vocabulaire/.test(t)) await setJob(jobId, { currentStep: "Vocabulaire…", progress: 80 });
        else if (/Compris pour/.test(t)) await setJob(jobId, { currentStep: "Récap…", progress: 95 });
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
  const job = await getJob(jobId);
  if (!job) { console.error("job introuvable: " + jobId); process.exit(1); }
  if (job.status === "canceled") process.exit(0);

  if (job.type === "ingest") {
    try {
      await runIngestJob(job.target);
      await setJob(jobId, { status: "done", progress: 100, currentStep: "Ingestion terminée ✓" });
      await logJob(jobId, "Ingestion terminée ✓");
      process.exit(0);
    } catch (e) {
      await fail((e as Error)?.message || String(e));
    }
    return;
  }

  // V10 — ONBOARDING d'un cours DEPUIS L'UI : prepare = ingestion (contenu + annales) → détection
  // du format → blueprint, en UN job avec progression (équivalent de `npm run prepare:course`).
  if (job.type === "prepare") {
    await setJob(jobId, { status: "running", pid: process.pid, currentStep: "Ingestion (contenu + annales)…", progress: 4 });
    try {
      await runIngestJob(null); // purge + ré-indexe content + refs du cours courant
      const refsN = (await q.get<{ n: number }>(`SELECT count(*) n FROM exam_refs`))?.n ?? 0;
      await setJob(jobId, { currentStep: `Corpus ingéré (refs : ${refsN})`, progress: 34 });
      if (COURSE === "cs-202") {
        await setJob(jobId, { status: "done", progress: 100, currentStep: `Cours prêt ✓ — refs ${refsN} (format/blueprint statiques)` });
        process.exit(0);
      }
      if (!llmAvailable()) {
        await setJob(jobId, { status: "done", progress: 100, currentStep: `Ingéré (refs ${refsN}). Claude/Max absent → format+blueprint à relancer une fois connecté.` });
        process.exit(0);
      }
      const { detectFormat } = await import("../lib/format");
      await detectFormat({ onStep: async (s, p) => { await setJob(jobId, { currentStep: `Format : ${s}`, progress: 34 + Math.round(p * 0.33) }); } });
      await setJob(jobId, { currentStep: "Format détecté — index exo-par-exo des finals…", progress: 50 });
      const { rebuildBlueprintFromIndex } = await import("../lib/program");
      const r = await rebuildBlueprintFromIndex({ onStep: async (s, p) => { await setJob(jobId, { currentStep: `Blueprint : ${s}`, progress: 50 + Math.round(p * 0.48) }); } });
      await setJob(jobId, { status: "done", progress: 100, currentStep: `Cours prêt ✓ — refs ${refsN}, ${r.exercises} exos indexés (${r.exams} finals) → ${r.types} types` });
      process.exit(0);
    } catch (e) { await fail((e as Error)?.message || String(e)); }
    return;
  }

  // V7 — (re)détection du format d'examen depuis les annales (après upload de finals).
  if (job.type === "format") {
    await setJob(jobId, { status: "running", pid: process.pid, currentStep: "Détection du format…", progress: 4 });
    if (!llmAvailable()) await fail(llmUnavailableReason()!);
    try {
      const { detectFormat } = await import("../lib/format");
      const onStep = async (s: string, p: number) => {
        const j = await getJob(jobId);
        if (j?.status === "canceled") { await logJob(jobId, "Annulé."); process.exit(0); }
        await setJob(jobId, { currentStep: s, progress: p, status: p >= 100 ? "done" : "running" });
        await logJob(jobId, s);
      };
      const f = await detectFormat({ onStep });
      await setJob(jobId, { status: "done", progress: 100, currentStep: `Format détecté : ${(f.format_summary || "").slice(0, 60)} ✓` });
      process.exit(0);
    } catch (e) { await fail((e as Error)?.message || String(e)); }
    return;
  }

  // V6 — examen QCM (cours générique au format QCM, ex. ML/CS-233).
  if (job.type === "qcm") {
    await setJob(jobId, { status: "running", pid: process.pid, currentStep: "Architecte QCM…", progress: 4 });
    await logJob(jobId, `Worker démarré (PID ${process.pid})`);
    if (!llmAvailable()) await fail(llmUnavailableReason()!);
    try {
      const { generateQcmExam } = await import("../lib/qcm");
      // V9 composeur : {count, openCount, focus} ; count/openCount peuvent valoir 0 (respectés).
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
        await setJob(jobId, { currentStep: s, progress: p, status: p >= 100 ? "done" : "running" });
        await logJob(jobId, s);
      };
      const res = await generateQcmExam({ count, openCount, focus, onStep });
      await setJob(jobId, { status: "done", progress: 100, resultId: res.id, resultPath: `/mock/${res.id}`, currentStep: `Mock QCM #${res.id} — ${res.count} QCM + ${res.open} ouverte(s) (${res.verified} vérifiés) ✓` });
      await logJob(jobId, `Mock QCM #${res.id} prêt → /mock/${res.id}`);
      process.exit(0);
    } catch (e) {
      await fail((e as Error)?.message || String(e));
    }
    return;
  }

  // PHASE 1 — analyse de blueprint (taxonomie typée + pondérée via Max + vision).
  if (job.type === "blueprint") {
    await setJob(jobId, { status: "running", pid: process.pid, currentStep: "Analyse du programme…", progress: 4 });
    await logJob(jobId, `Worker démarré (PID ${process.pid})`);
    if (!llmAvailable()) await fail(llmUnavailableReason()!);
    const n = (await q.get<{ n: number }>("SELECT count(*) n FROM items"))?.n ?? 0;
    if (!n) await fail("Corpus non ingéré. Lance « npm run ingest » d'abord.");
    try {
      const onStep = async (s: string, p: number) => {
        const j = await getJob(jobId);
        if (j?.status === "canceled") { await logJob(jobId, "Annulé."); process.exit(0); }
        await setJob(jobId, { currentStep: s, progress: p, status: p >= 100 ? "done" : "running" });
        await logJob(jobId, s);
      };
      const { rebuildBlueprintFromIndex } = await import("../lib/program");
      const res = await rebuildBlueprintFromIndex({ onStep });
      await setJob(jobId, { status: "done", progress: 100, resultId: res.types, currentStep: `Index : ${res.exercises} exos (${res.exams} finals) → ${res.types} types ✓` });
      await logJob(jobId, `Blueprint exhaustif → ${res.exercises} exos indexés, ${res.types} types.`);
      process.exit(0);
    } catch (e) {
      await fail((e as Error)?.message || String(e));
    }
    return;
  }

  await setJob(jobId, { status: "running", pid: process.pid, currentStep: "Pré-vérifications…", progress: 2 });
  await logJob(jobId, `Worker démarré (PID ${process.pid})`);

  // ---- Pré-checks (Phase 4) : échec clair AVANT 20 min de travail ----
  if (!llmAvailable()) await fail(llmUnavailableReason()!);
  const items = (await q.get<{ n: number }>("SELECT count(*) n FROM items"))?.n ?? 0;
  if (!items) await fail("Corpus non ingéré. Lance « npm run ingest » d'abord.");
  if (!texAvailable()) await logJob(jobId, "⚠ tectonic/pdflatex absent → repli HTML. Installe tectonic (brew install tectonic) pour le vrai PDF.");
  await logJob(jobId, "Pré-checks OK");

  const onStep = async (s: string, p: number) => {
    const j = await getJob(jobId);
    if (j?.status === "canceled") { await logJob(jobId, "Annulé."); process.exit(0); }
    const status = p >= 100 ? "done" : p >= 92 ? "compiling" : p >= 45 ? "verifying" : "running";
    await setJob(jobId, { currentStep: s, progress: p, status });
    await logJob(jobId, s);
  };

  // V9 composeur (CS-202) : count d'exercices optionnel dans le target du job 'exam'.
  let examCount: number | undefined;
  if (job.type === "exam" && job.target) { try { examCount = Number(JSON.parse(job.target).count) || undefined; } catch {} }

  try {
    const res =
      job.type === "exercise"
        ? await generateTargetedExercise(job.target ?? "", { onStep })
        : job.type === "lab-exercise"
          ? await generateLabExercise(job.target ?? "", { onStep })
          : await generateExamViaClaudeCode({ count: examCount, onStep });
    if (res.texError) {
      // le résultat existe (HTML lisible) mais le PDF a échoué → erreur LaTeX gardée pour debug
      await setJob(jobId, { error: `Compilation LaTeX échouée — PDF indisponible, repli HTML lisible. Détail : ${res.texError.slice(0, 500)}` });
      await logJob(jobId, `⚠ Erreur LaTeX : ${res.texError.slice(0, 300)}`);
    }
    await setJob(jobId, { status: "done", progress: 100, resultPath: res.url, resultId: res.id, currentStep: "Terminé ✓" });
    await logJob(jobId, `${job.type === "exercise" ? "Exercice" : job.type === "lab-exercise" ? "Exercice Labs" : "Examen"} #${res.id} prêt → ${res.url}`);
    process.exit(0);
  } catch (e) {
    await fail((e as Error)?.message || String(e));
  }
}

main();
