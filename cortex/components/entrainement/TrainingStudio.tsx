"use client";

/* eslint-disable react-hooks/set-state-in-effect -- les effets réinitialisent le studio au changement de cours et lisent le lien profond */

import styles from "@/app/secondary.module.css";
import { useEffect, useRef, useState } from "react";
import {
  Target,
  Sparkles,
  FileText,
  CheckSquare,
  Gauge,
  Lightbulb,
  Eye,
  CloudOff,
  AlertTriangle,
  Check,
  X,
} from "lucide-react";
import { Panel } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { ImageTextArea } from "@/components/ui/ImageTextArea";
import { SafeHtml } from "@/components/ui/SafeHtml";
import { MathText } from "@/components/ui/MathText";
import { GenerationProgress } from "@/components/generation/GenerationProgress";
import { useJobError } from "@/components/generation/useJobError";
import { notifyJobStarted } from "@/lib/ux/generation-tracker";
import { apiPost, useApi, useCourse, useJob, findActiveJob, JOB_ACTIVE, jobEnd, jobInUrl, rememberJobInUrl, webAssistJobs, type ApiError, engineDown } from "@/lib/ux/api";
import {
  FEEDBACK_OPTIONS,
  examLinkFromResultPath,
  type DrillListResp,
} from "@/lib/ux/training";
import { cn } from "@/lib/ux/cn";
import { UsageLine, useLaunchUsage } from "@/components/billing/UsageIndicator";
import { useTranslations } from "use-intl/react";

/**
 * Studio d'entraînement RÉEL — UNE seule zone (REFONTE ALLÉGÉE, plus de mode Drill/Architecte).
 * Tu donnes un concept, une consigne, une image, ou tu piques une puce (dus / faiblesses) →
 * Cortex produit un exo AU FORMAT DU FINAL, avec les indices progressifs en OPTION sur le résultat.
 *  - texte seul  → POST /api/drill (JOB) : énoncé + 5 indices progressifs + solution, lus sur le job ;
 *  - avec image  → POST /api/exercises/generate (JOB) : énoncé/corrigé PDF (pipeline architecte).
 * Les deux sont des jobs : quitter la page ou recharger ne perd rien (reprise du suivi, `?job=`
 * pour relire un exercice prêt, notification de fin ailleurs dans l'app).
 * Retour difficulté → POST /api/feedback (recalibre la difficulté).
 */

// Le dernier exercice ciblé affiché, par cours : un exercice fini pendant l'absence revient une fois.
const seenKey = (course: string) => `cortex:drill-seen:${course}`;
function drillSeen(course: string): number {
  try { return Number(window.localStorage.getItem(seenKey(course))) || 0; } catch { return 0; }
}
function markDrillSeen(course: string, id: number): void {
  try { if (id > drillSeen(course)) window.localStorage.setItem(seenKey(course), String(id)); } catch { /* stockage indisponible */ }
}
export function TrainingStudio() {
  const t = useTranslations("trainingStudio");
  const apiT = useTranslations("api");
  const { courseId, course } = useCourse();
  const language = course?.language || undefined; // "" = langue pas encore détectée : pas de lang vide
  const list = useApi<DrillListResp>("/api/drill");

  const [input, setInput] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [prefillNote, setPrefillNote] = useState<string | null>(null); // concept pré-rempli depuis Faiblesses

  const [shownHints, setShownHints] = useState(0);
  const [showSolution, setShowSolution] = useState(false);

  const [jobId, setJobId] = useState<number | null>(null);
  const [launching, setLaunching] = useState(false);
  const job = useJob(jobId);
  const jobError = useJobError();
  const jobRunning = launching || (job != null && JOB_ACTIVE.includes(job.status));
  // Un exercice annulé n'est ni prêt ni en échec : le panneau revient à son état d'avant.
  const end = job ? jobEnd(job.status) : null;
  // Exercice ciblé (job drill) prêt : son énoncé, ses indices et son corrigé viennent du job.
  const drill = end === "done" && job?.type === "drill" ? job.drill ?? null : null;
  const jobDone = end === "done" && job?.type === "exercise";
  const jobFailed = end === "failed" || (end === "done" && job?.type === "drill" && !drill);

  const [error, setError] = useState<{ offline: boolean; message: string } | null>(null);
  const [fbSent, setFbSent] = useState<string | null>(null);
  const [fbBusy, setFbBusy] = useState(false);
  const [fbError, setFbError] = useState<string | null>(null);

  const busy = jobRunning;
  // Avec image : exercice (job) ; sinon : question d'entraînement (aide). Même verdict que la route visée.
  const launch = useLaunchUsage(image ? "exercise" : "drill");
  const { refresh: refreshUsage } = launch;
  useEffect(() => { if (!busy) refreshUsage(); }, [busy, refreshUsage]);

  // Réinitialise l'ÉTAT RÉSULTAT au changement de cours. On ne touche PAS à input/image/prefillNote :
  // le cours initial se résout de cs-202 → ml via un effet (courseId change au montage) ; effacer
  // l'input ici écraserait le pré-remplissage ?prefill= (déposé au montage). Le × / l'édition suffisent.
  useEffect(() => {
    setJobId(null); setError(null); setFbSent(null); setFbError(null); setShownHints(0); setShowSolution(false);
    let alive = true;
    if (courseId) {
      // Retour sur la page : l'exercice en cours d'abord (lancé ici avant de partir, ou dans un autre
      // onglet), puis celui de l'adresse (rechargement, notification de fin), puis un exercice ciblé
      // fini pendant l'absence et pas encore affiché. Ceux d'un assistant (MCP) restent à l'assistant.
      void Promise.all([findActiveJob(courseId, ["exercise"]), webAssistJobs(courseId, "drill")]).then(([exercise, drills]) => {
        const running = [exercise, drills.find((j) => JOB_ACTIVE.includes(j.status))].filter((j) => j != null).sort((a, b) => b.id - a.id)[0];
        const unseen = drills.find((j) => j.status === "done" && j.id > drillSeen(courseId));
        const id = running?.id ?? jobInUrl(courseId) ?? unseen?.id ?? null;
        if (alive && id) setJobId(id);
      });
    }
    return () => { alive = false; };
  }, [courseId]);

  // Exercice ciblé affiché : il ne revient plus de lui-même au retour sur la page.
  useEffect(() => {
    if (drill && job && courseId) markDrillSeen(courseId, job.id);
  }, [drill, job, courseId]);

  // Exercice repris (retour, rechargement) : sa notion revient dans la zone, pour le relancer tel quel.
  const resumed = useRef<number | null>(null);
  useEffect(() => {
    if (!job || resumed.current === job.id) return;
    resumed.current = job.id;
    // `?job=` d'un autre type (lien bricolé) : ce n'est pas un exercice, on l'ignore.
    if (job.type !== "drill" && job.type !== "exercise") { setJobId(null); return; }
    if (job.type !== "drill") return;
    try {
      const concept = String((JSON.parse(job.target ?? "{}") as { concept?: unknown }).concept ?? "").trim();
      if (concept) setInput((cur) => cur.trim() ? cur : concept);
    } catch { /* cible illisible */ }
  }, [job]);


  // Deep-link ?prefill=<concept> (bouton « S'entraîner » des Faiblesses ; legacy ?drill= toléré).
  // On PRÉ-REMPLIT la box (éditable, × pour vider) — SANS lancer : l'étudiant garde la main.
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current) return;
    const params = new URLSearchParams(window.location.search);
    const c = (params.get("prefill") ?? params.get("drill") ?? "").trim();
    if (c) {
      prefilled.current = true;
      setInput(c);
      setPrefillNote(c);
    }
  }, []);

  async function launchDrill(c?: string) {
    const chosen = (c ?? input).trim();
    if (!chosen || busy) return;
    setError(null); setJobId(null); setFbSent(null); setFbError(null);
    setShownHints(0); setShowSolution(false);
    setLaunching(true);
    try {
      const d = await apiPost<{ ok: boolean; jobId: number }>("/api/drill", courseId, { concept: chosen }, (status) => apiT("httpError", { status }));
      setJobId(d.jobId);
      rememberJobInUrl(d.jobId, courseId);
      notifyJobStarted();
    } catch (e) {
      const err = e as ApiError;
      setError({
        offline: engineDown(err),
        message: engineDown(err)
          ? t("llmUnavailable")
          : err.message || t("generationFailed"),
      });
    } finally {
      setLaunching(false);
    }
  }

  async function launchArchitect() {
    if (busy) return;
    setError(null); setFbSent(null); setFbError(null); setJobId(null);
    setLaunching(true);
    try {
      const fd = new FormData();
      if (input.trim()) fd.append("target", input.trim());
      if (image) fd.append("image", image);
      const res = await fetch(`/api/exercises/generate?course=${encodeURIComponent(courseId)}`, { method: "POST", body: fd });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw { status: res.status, message: d?.error ?? apiT("httpError", { status: res.status }), code: typeof d?.code === "string" ? d.code : null, params: d?.params } as ApiError;
      setJobId(d.jobId);
      rememberJobInUrl(d.jobId, courseId);
      notifyJobStarted();
    } catch (e) {
      const err = e as ApiError;
      setError({
        offline: engineDown(err),
        message: engineDown(err)
          ? t("llmGenerationUnavailable")
          : err.message || t("startFailed"),
      });
    } finally {
      setLaunching(false);
    }
  }

  const submit = () => {
    if (busy) return;
    if (!input.trim() && !image) {
      setError({ offline: false, message: t("inputRequired") });
      return;
    }
    // avec image → pipeline architecte (PDF) ; sinon → drill (énoncé + indices progressifs).
    if (image) launchArchitect();
    else launchDrill();
  };

  async function sendFeedback(verdict: string) {
    if (fbBusy || fbSent) return;
    setFbBusy(true);
    setFbError(null);
    try {
      await apiPost("/api/feedback", courseId, {
        examId: jobDone ? (job as { resultId?: number }).resultId : undefined,
        topic: drill?.concept ?? (input.trim() || undefined),
        verdict,
      }, (status) => apiT("httpError", { status }));
      setFbSent(verdict);
    } catch (error) {
      setFbError((error as ApiError).message || t("feedbackFailed"));
    } finally {
      setFbBusy(false);
    }
  }

  const resultLink = jobDone ? examLinkFromResultPath(job?.resultPath ?? null, courseId) : null;
  // Demande partie, premier retour pas encore arrivé (job pas encore créé ou pas encore lu).
  const waiting = jobRunning && !job;
  // Le panneau de résultat n'existe que s'il a quelque chose à montrer : pas de grand cadre vide
  // « ton exo apparaîtra ici » à côté du formulaire.
  const hasResult = !!drill || busy || jobDone || jobFailed;

  // Sur mobile le résultat arrive sous le formulaire, hors de l'écran : on l'y amène.
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasResult) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    resultRef.current?.scrollIntoView({ block: "nearest", behavior: calm ? "auto" : "smooth" });
  }, [hasResult]);
  const dueChips = list.data?.due ?? [];
  const weakChips = list.data?.weaknesses ?? [];

  return (
    <div className={styles.split}>
      {/* ── Zone unique d'entrée ── */}
      <Panel className="p-6 sm:p-8">
        <h2 className="font-display text-[1.5rem] font-semibold leading-tight text-ink-1">{t("title")}</h2>

        {/* pré-remplissage depuis Faiblesses : bandeau éditable + × pour vider */}
        {prefillNote && input === prefillNote && (
          <div className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-[color-mix(in_oklch,var(--color-accent)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-accent)_9%,transparent)] px-3 py-2 text-[0.78rem] text-ink-2">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Target className="size-3.5 shrink-0 text-accent-hi" strokeWidth={2.25} />
              <span className="truncate">{t("prefilled")}</span>
            </span>
            <button
              type="button"
              onClick={() => { setInput(""); setPrefillNote(null); }}
              aria-label={t("clearPrefill")}
              className="grid size-6 shrink-0 place-items-center rounded text-ink-3 transition-colors hover:text-ink-1 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            >
              <X className="size-3.5" strokeWidth={2.5} />
            </button>
          </div>
        )}

        {/* zone unique : texte + IMAGE INLINE (P-B) — colle / glisse une image, continue à écrire */}
        <div className="mt-3">
          <ImageTextArea
            value={input}
            onChange={setInput}
            image={image}
            onImageChange={setImage}
            rows={5}
            ariaLabel={t("inputLabel")}
            placeholder={t("inputPlaceholder")}
            onEnter={submit}
          />
        </div>

        {list.error && (
          <div className="mt-4 rounded-xl border border-line p-3 text-sm text-ink-3">
            <p>{t("suggestionsUnavailable")}</p>
            <Button className="mt-2" size="sm" onClick={list.refetch}>{t("reloadSuggestions")}</Button>
          </div>
        )}
        {/* puces : dus / faiblesses réels */}
        {!list.loading && !list.error && (dueChips.length > 0 || weakChips.length > 0) && (
          <div className="mt-4 space-y-3">
            {dueChips.length > 0 && <ChipGroup label={t("due")} chips={dueChips} onPick={setInput} selected={input} language={language} />}
            {weakChips.length > 0 && <ChipGroup label={t("weaknesses")} chips={weakChips} onPick={setInput} selected={input} language={language} />}
          </div>
        )}

        <Button variant="primary" onClick={submit} loading={busy} disabled={!busy && !launch.allowed} className="mt-5 w-full">
          {!busy && <Sparkles className="size-4" strokeWidth={2.5} />}
          {busy ? t("generating") : t("generate")}
        </Button>
        {!busy && <UsageLine usage={launch.usage} now={launch.now} className="mt-2" />}

        {error && (
          <div
            role="alert"
            className={cn(
              "mt-3 flex items-start gap-2.5 rounded-lg border p-3 text-[0.84rem] leading-relaxed text-ink-2",
              error.offline
                ? "border-[color-mix(in_oklch,var(--color-warning)_38%,transparent)] bg-[color-mix(in_oklch,var(--color-warning)_8%,transparent)]"
                : "border-[color-mix(in_oklch,var(--color-danger)_38%,transparent)] bg-[color-mix(in_oklch,var(--color-danger)_8%,transparent)]"
            )}
          >
            {error.offline ? <CloudOff className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={2} /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger-hi" strokeWidth={2} />}
            {error.message}
          </div>
        )}
      </Panel>

      {/* Résultat unique, uniquement après une demande d’exercice. */}
      {hasResult && (
      <Panel ref={resultRef} className="flex scroll-mt-20 flex-col gap-2 p-6 sm:p-8">
        {drill ? (
          <>
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-[0.72rem] font-medium text-emerald-hi">
                <span className="inline-block size-1.5 rounded-full bg-emerald" /> {t("readyShort")}
              </span>
              <span className="text-[0.76rem] text-ink-4">{t("finalFormat")}</span>
            </div>
            <h2 className="mt-3 text-[1.05rem] font-semibold text-ink-1" lang={language}>{drill.concept}</h2>
            <div lang={language}><SafeHtml className="prose-exam mt-3 text-[0.9rem] leading-relaxed text-ink-1" html={drill.statement_html} math /></div>

            {drill.hints.length > 0 && (
              <div className="mt-4 space-y-2">
                {drill.hints.slice(0, shownHints).map((h, i) => (
                  <div key={i} className="rise-in flex items-start gap-2.5 rounded-lg border border-line bg-surface-2/40 p-3 text-[0.84rem] text-ink-2">
                    <Lightbulb className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={2} />
                    <span lang={language}><span className="mr-1.5 font-data text-[0.72rem] font-semibold text-ink-3">{i + 1}/{drill.hints.length}</span><MathText text={h} /></span>
                  </div>
                ))}
                {shownHints < drill.hints.length && (
                  <Button variant="subtle" size="sm" onClick={() => setShownHints((n) => n + 1)}>
                    <Lightbulb className="size-3.5" strokeWidth={2.25} />
                    {t("nextHint", { shown: shownHints, total: drill.hints.length })}
                  </Button>
                )}
              </div>
            )}

            <div className="mt-4 border-t border-line pt-4">
              {showSolution ? (
                <div lang={language}><SafeHtml className="prose-exam text-[0.88rem] leading-relaxed text-ink-2" html={drill.solution_html} math /></div>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => setShowSolution(true)}>
                  <Eye className="size-3.5" strokeWidth={2.25} /> {t("showSolution")}
                </Button>
              )}
            </div>
            <FeedbackBar onSend={sendFeedback} sent={fbSent} busy={fbBusy} error={fbError} />
          </>
        ) : waiting || (jobRunning && job) ? (
          <div className="flex flex-1 flex-col justify-center">
            {/* Exercice ciblé : une aide, qui ne s'annule pas (son prix est réglé au lancement). */}
            <GenerationProgress job={job} meanwhile={false} cancelable={job?.type !== "drill"} />
          </div>
        ) : jobDone ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-[0.72rem] font-medium text-emerald-hi">
              <Check className="size-3.5" strokeWidth={2.5} /> {t("ready")}
            </span>
            <h2 className="mt-3 text-[1.05rem] font-semibold text-ink-1" lang={input.trim() ? language : undefined}>{input.trim() || t("customExercise")}</h2>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <a href={resultLink ?? "/examens"} target={resultLink ? "_blank" : undefined} rel="noopener noreferrer" className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 p-3 transition-colors hover:border-[color-mix(in_oklch,var(--color-accent)_34%,transparent)]">
                <FileText className="size-5 text-ink-3" strokeWidth={2} />
                <span className="text-[0.82rem] font-medium text-ink-1">{resultLink ? t("questionPdf") : t("viewInExams")}</span>
              </a>
              <a href="/examens" className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 p-3 transition-colors hover:border-[color-mix(in_oklch,var(--color-accent)_34%,transparent)]">
                <CheckSquare className="size-5 text-ink-3" strokeWidth={2} />
                <span className="text-[0.82rem] font-medium text-ink-1">{t("solution")}</span>
              </a>
            </div>
            <FeedbackBar onSend={sendFeedback} sent={fbSent} busy={fbBusy} error={fbError} />
          </>
        ) : jobFailed ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <AlertTriangle className="size-6 text-danger-hi" strokeWidth={2} />
            <p className="text-[0.9rem] font-medium text-ink-1">{t("failedTitle")}</p>
            <p role="alert" className="max-w-xs text-sm text-ink-3">{jobError(job?.error) ?? t("failedHint")}</p>
            <Button variant="secondary" onClick={submit}>{t("retryGeneration")}</Button>
          </div>
        ) : null}
      </Panel>
      )}
    </div>
  );
}

function FeedbackBar({ onSend, sent, busy, error }: { onSend: (verdict: string) => void; sent: string | null; busy: boolean; error: string | null }) {
  const t = useTranslations("trainingStudio");
  return (
    <div className="mt-auto border-t border-line pt-4">
      <div className="mb-2.5 flex items-center gap-2 text-[0.82rem] text-ink-2">
        <Gauge className="size-4 text-ink-3" strokeWidth={2.25} />
        {t("feedbackQuestion")}
      </div>
      <div className="flex flex-wrap gap-2">
        {FEEDBACK_OPTIONS.map((o) => (
          <button
            key={o.verdict}
            type="button"
            onClick={() => onSend(o.verdict)}
            disabled={busy || !!sent}
            aria-pressed={sent === o.verdict}
            className={cn(
              "min-h-11 rounded-full border px-3 text-[0.8rem] font-medium transition-colors disabled:opacity-60",
              sent === o.verdict
                ? "border-[color-mix(in_oklch,var(--color-accent)_50%,transparent)] bg-[color-mix(in_oklch,var(--color-accent)_16%,transparent)] text-ink-1"
                : "border-line bg-surface-2/40 text-ink-2 hover:bg-surface-2 hover:text-ink-1"
            )}
          >
            {t(o.labelKey)}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-danger-hi">{error}</p>}
      {sent && <p className="mt-2 text-[0.78rem] text-emerald-hi" aria-live="polite">{t("feedbackThanks")}</p>}
    </div>
  );
}

function ChipGroup({ label, chips, onPick, selected, language }: { label: string; chips: string[]; onPick: (c: string) => void; selected: string; language?: string }) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium text-ink-4">{label}</div>
      <div className="flex flex-wrap gap-2">
        {chips.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onPick(c)}
            aria-pressed={selected === c}
            title={c}
            className={cn(
              "inline-flex min-h-9 max-w-full items-center rounded-full border px-3 py-1 text-left text-[0.8rem] font-medium transition-colors",
              selected === c
                ? "border-[color-mix(in_oklch,var(--color-accent)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-accent)_14%,transparent)] text-ink-1"
                : "border-line bg-surface-1/60 text-ink-2 hover:bg-surface-2 hover:text-ink-1"
            )}
          >
            <span className="truncate" lang={language}>{c}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
