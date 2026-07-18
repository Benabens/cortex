"use client";

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
import { WeightBar } from "@/components/viz/WeightBar";
import { apiPost, useApi, useCourse, useJob, JOB_ACTIVE, asText, type ApiError } from "@/lib/ux/api";
import {
  FEEDBACK_OPTIONS,
  examLinkFromResultPath,
  type Drill,
  type DrillListResp,
} from "@/lib/ux/training";
import { cn } from "@/lib/ux/cn";

/**
 * Studio d'entraînement RÉEL — UNE seule zone (REFONTE ALLÉGÉE, plus de mode Drill/Architecte).
 * Tu donnes un concept, une consigne, une image, ou tu piques une puce (dus / faiblesses) →
 * Cortex produit un exo AU FORMAT DU FINAL, avec les indices progressifs en OPTION sur le résultat.
 *  - texte seul  → POST /api/drill (sync) : énoncé + 5 indices progressifs + solution ;
 *  - avec image  → POST /api/exercises/generate (JOB) : énoncé/corrigé PDF (pipeline architecte).
 * Retour difficulté → POST /api/feedback (recalibre la difficulté).
 */
export function TrainingStudio() {
  const { courseId } = useCourse();
  const list = useApi<DrillListResp>("/api/drill");

  const [input, setInput] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [prefillNote, setPrefillNote] = useState<string | null>(null); // concept pré-rempli depuis Faiblesses

  const [drill, setDrill] = useState<Drill | null>(null);
  const [drilling, setDrilling] = useState(false);
  const [shownHints, setShownHints] = useState(0);
  const [showSolution, setShowSolution] = useState(false);

  const [jobId, setJobId] = useState<number | null>(null);
  const [launching, setLaunching] = useState(false);
  const job = useJob(jobId);
  const jobRunning = launching || (job != null && JOB_ACTIVE.includes(job.status));
  const jobDone = job != null && !JOB_ACTIVE.includes(job.status) && job.status !== "error" && job.status !== "failed";
  const jobFailed = job != null && (job.status === "error" || job.status === "failed");

  const [error, setError] = useState<{ offline: boolean; message: string } | null>(null);
  const [fbSent, setFbSent] = useState<string | null>(null);
  const [fbBusy, setFbBusy] = useState(false);

  const busy = drilling || jobRunning;

  // Réinitialise l'ÉTAT RÉSULTAT au changement de cours. On ne touche PAS à input/image/prefillNote :
  // le cours initial se résout de cs-202 → ml via un effet (courseId change au montage) ; effacer
  // l'input ici écraserait le pré-remplissage ?prefill= (déposé au montage). Le × / l'édition suffisent.
  useEffect(() => {
    setDrill(null); setJobId(null); setError(null); setFbSent(null); setShownHints(0); setShowSolution(false);
  }, [courseId]);

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
    setError(null); setDrill(null); setJobId(null); setFbSent(null);
    setShownHints(0); setShowSolution(false);
    setDrilling(true);
    try {
      const d = await apiPost<{ ok: boolean; drill: Drill }>("/api/drill", courseId, { concept: chosen });
      setDrill(d.drill);
    } catch (e) {
      const err = e as ApiError;
      setError({
        offline: err.status === 503,
        message: err.status === 503
          ? "Claude Max n’est pas joignable. Lance Cortex sur ta machine connectée, puis réessaie."
          : err.message || "La génération a échoué. Réessaie.",
      });
    } finally {
      setDrilling(false);
    }
  }

  async function launchArchitect() {
    if (busy) return;
    setError(null); setDrill(null); setFbSent(null); setJobId(null);
    setLaunching(true);
    try {
      const fd = new FormData();
      if (input.trim()) fd.append("target", input.trim());
      if (image) fd.append("image", image);
      const res = await fetch(`/api/exercises/generate?course=${encodeURIComponent(courseId)}`, { method: "POST", body: fd });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw { status: res.status, message: d?.error ?? `Erreur ${res.status}` } as ApiError;
      setJobId(d.jobId);
    } catch (e) {
      const err = e as ApiError;
      setError({
        offline: err.status === 503,
        message: err.status === 503
          ? "Claude Max n’est pas joignable — impossible de générer pour l’instant."
          : err.message || "Impossible de lancer la génération.",
      });
    } finally {
      setLaunching(false);
    }
  }

  const submit = () => {
    if (busy) return;
    if (!input.trim() && !image) {
      setError({ offline: false, message: "Donne un concept, une consigne, ou une image d’exercice." });
      return;
    }
    // avec image → pipeline architecte (PDF) ; sinon → drill (énoncé + indices progressifs).
    if (image) launchArchitect();
    else launchDrill();
  };

  async function sendFeedback(verdict: string) {
    if (fbBusy || fbSent) return;
    setFbBusy(true);
    try {
      await apiPost("/api/feedback", courseId, {
        examId: jobDone ? (job as { resultId?: number }).resultId : undefined,
        topic: drill?.concept ?? (input.trim() || undefined),
        verdict,
      });
      setFbSent(verdict);
    } catch {
      setFbSent(verdict);
    } finally {
      setFbBusy(false);
    }
  }

  const resultLink = jobDone ? examLinkFromResultPath(job?.resultPath ?? null, courseId) : null;
  const dueChips = list.data?.due ?? [];
  const weakChips = list.data?.weaknesses ?? [];

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.15fr_1fr]">
      {/* ── Zone unique d'entrée ── */}
      <Panel className="p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <Target className="size-4 text-violet-hi" strokeWidth={2.5} />
          <h2 className="text-[1.05rem] font-semibold text-ink-1">Génère un exo à travailler</h2>
        </div>
        <p className="mt-1 text-[0.86rem] text-ink-2">
          Un concept, une consigne, ou une image — Cortex produit un exo au format du final.
        </p>

        {/* pré-remplissage depuis Faiblesses : bandeau éditable + × pour vider */}
        {prefillNote && input === prefillNote && (
          <div className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-[color-mix(in_oklch,var(--color-violet)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-violet)_9%,transparent)] px-3 py-2 text-[0.78rem] text-ink-2">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Target className="size-3.5 shrink-0 text-violet-hi" strokeWidth={2.25} />
              <span className="truncate">Pré-rempli depuis une faiblesse — modifie-le ou lance tel quel.</span>
            </span>
            <button
              type="button"
              onClick={() => { setInput(""); setPrefillNote(null); }}
              aria-label="Vider le pré-remplissage"
              className="grid size-6 shrink-0 place-items-center rounded text-ink-3 transition-colors hover:text-ink-1 focus-visible:outline-2 focus-visible:outline-violet focus-visible:outline-offset-2"
            >
              <X className="size-3.5" strokeWidth={2.5} />
            </button>
          </div>
        )}

        {/* zone unique : texte + IMAGE INLINE (P-B) — colle ⌘V / glisse une image, continue à écrire */}
        <div className="mt-3">
          <ImageTextArea
            value={input}
            onChange={setInput}
            image={image}
            onImageChange={setImage}
            rows={3}
            ariaLabel="Concept, consigne ou énoncé à travailler (image collable)"
            placeholder="Ex. « rétropropagation », « max-flow avec une coupe » — ou colle une consigne / un énoncé…"
            onEnter={submit}
          />
        </div>

        {/* puces : dus / faiblesses réels */}
        {!list.loading && !list.error && (dueChips.length > 0 || weakChips.length > 0) && (
          <div className="mt-4 space-y-3">
            {dueChips.length > 0 && <ChipGroup label="À réviser (dus)" chips={dueChips} onPick={setInput} selected={input} />}
            {weakChips.length > 0 && <ChipGroup label="Tes faiblesses" chips={weakChips} onPick={setInput} selected={input} />}
          </div>
        )}

        <Button variant="primary" onClick={submit} loading={busy} className="mt-5 w-full">
          {!busy && <Sparkles className="size-4" strokeWidth={2.5} />}
          {busy ? "Génération…" : "Générer l’exercice"}
        </Button>

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

      {/* ── Résultat unique ── */}
      <Panel className="flex flex-col p-5 sm:p-6">
        {drill ? (
          <>
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-[0.72rem] font-medium text-emerald-hi">
                <span className="inline-block size-1.5 rounded-full bg-emerald" /> Exo prêt
              </span>
              <span className="text-[0.76rem] text-ink-4">au format du final</span>
            </div>
            <h2 className="mt-3 text-[1.05rem] font-semibold text-ink-1">{drill.concept}</h2>
            <div className="prose-exam mt-3 text-[0.9rem] leading-relaxed text-ink-1" dangerouslySetInnerHTML={{ __html: drill.statement_html }} />

            {drill.hints.length > 0 && (
              <div className="mt-4 space-y-2">
                {drill.hints.slice(0, shownHints).map((h, i) => (
                  <div key={i} className="rise-in flex items-start gap-2.5 rounded-lg border border-line bg-surface-2/40 p-3 text-[0.84rem] text-ink-2">
                    <Lightbulb className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={2} />
                    <span><span className="mr-1.5 font-data text-[0.72rem] font-semibold text-ink-3">{i + 1}/{drill.hints.length}</span>{h}</span>
                  </div>
                ))}
                {shownHints < drill.hints.length && (
                  <Button variant="subtle" size="sm" onClick={() => setShownHints((n) => n + 1)}>
                    <Lightbulb className="size-3.5" strokeWidth={2.25} />
                    Indice suivant ({shownHints}/{drill.hints.length})
                  </Button>
                )}
              </div>
            )}

            <div className="mt-4 border-t border-line pt-4">
              {showSolution ? (
                <div className="prose-exam text-[0.88rem] leading-relaxed text-ink-2" dangerouslySetInnerHTML={{ __html: drill.solution_html }} />
              ) : (
                <Button variant="secondary" size="sm" onClick={() => setShowSolution(true)}>
                  <Eye className="size-3.5" strokeWidth={2.25} /> Voir la solution
                </Button>
              )}
            </div>
            <FeedbackBar onSend={sendFeedback} sent={fbSent} busy={fbBusy} />
          </>
        ) : jobRunning && job ? (
          <div className="flex flex-1 flex-col justify-center gap-3" aria-live="polite">
            <p className="text-[0.9rem] font-medium text-ink-1">{job.status === "queued" ? "En file d’attente…" : "Génération de l’exercice…"}</p>
            {asText(job.currentStep) && <p className="text-[0.82rem] text-ink-3">{asText(job.currentStep)}</p>}
            <WeightBar pct={job.status === "queued" ? 4 : job.progress} height={6} />
            <p className="font-data text-[0.82rem] font-semibold text-ink-2">{job.status === "queued" ? "" : `${job.progress} %`}</p>
          </div>
        ) : jobDone ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-[0.72rem] font-medium text-emerald-hi">
              <Check className="size-3.5" strokeWidth={2.5} /> Exercice prêt
            </span>
            <h2 className="mt-3 text-[1.05rem] font-semibold text-ink-1">{input.trim() || "Exercice sur mesure"}</h2>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <a href={resultLink ?? "/examens"} target={resultLink ? "_blank" : undefined} rel="noopener noreferrer" className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 p-3 transition-colors hover:border-[color-mix(in_oklch,var(--color-violet)_34%,transparent)]">
                <FileText className="size-5 text-cyan-hi" strokeWidth={2} />
                <span className="text-[0.82rem] font-medium text-ink-1">{resultLink ? "Énoncé PDF" : "Voir dans Examens"}</span>
              </a>
              <a href="/examens" className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 p-3 transition-colors hover:border-[color-mix(in_oklch,var(--color-emerald)_34%,transparent)]">
                <CheckSquare className="size-5 text-emerald-hi" strokeWidth={2} />
                <span className="text-[0.82rem] font-medium text-ink-1">Corrigé</span>
              </a>
            </div>
            <FeedbackBar onSend={sendFeedback} sent={fbSent} busy={fbBusy} />
          </>
        ) : jobFailed ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <AlertTriangle className="size-6 text-danger-hi" strokeWidth={2} />
            <p className="text-[0.9rem] font-medium text-ink-1">La génération a échoué</p>
            <p className="max-w-xs text-[0.82rem] text-ink-3">{asText(job?.error) ?? "Réessaie — si ça persiste, vérifie Claude Max et le moteur LaTeX."}</p>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
            <span className="grid size-11 place-items-center rounded-lg border border-line bg-surface-2/60 text-ink-3">
              <Target className="size-5" strokeWidth={2} />
            </span>
            <p className="text-[0.92rem] font-medium text-ink-1">Ton prochain exo apparaîtra ici</p>
            <p className="max-w-xs text-[0.82rem] leading-relaxed text-ink-3">
              Donne un concept, une consigne ou une image — Cortex génère un exo au format du vrai final,
              avec des indices progressifs à révéler si tu bloques.
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}

function FeedbackBar({ onSend, sent, busy }: { onSend: (verdict: string) => void; sent: string | null; busy: boolean }) {
  return (
    <div className="mt-auto border-t border-line pt-4">
      <div className="mb-2.5 flex items-center gap-2 text-[0.82rem] text-ink-2">
        <Gauge className="size-4 text-ink-3" strokeWidth={2.25} />
        Au niveau d’un vrai final ?
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
              "h-10 rounded-md border px-3 text-[0.8rem] font-medium transition-colors disabled:opacity-60",
              sent === o.verdict
                ? "border-[color-mix(in_oklch,var(--color-violet)_50%,transparent)] bg-[color-mix(in_oklch,var(--color-violet)_16%,transparent)] text-ink-1"
                : "border-line bg-surface-2/40 text-ink-2 hover:bg-surface-2 hover:text-ink-1"
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {sent && <p className="mt-2 text-[0.78rem] text-emerald-hi" aria-live="polite">Merci — Cortex recalibre la difficulté des prochains exos.</p>}
    </div>
  );
}

function ChipGroup({ label, chips, onPick, selected }: { label: string; chips: string[]; onPick: (c: string) => void; selected: string }) {
  return (
    <div>
      <div className="mb-2 text-[0.72rem] font-medium text-ink-4">{label}</div>
      <div className="flex flex-wrap gap-2">
        {chips.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onPick(c)}
            aria-pressed={selected === c}
            className={cn(
              "inline-flex min-h-9 items-center rounded-full border px-3 py-1 text-left text-[0.8rem] font-medium transition-colors",
              selected === c
                ? "border-[color-mix(in_oklch,var(--color-violet)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-violet)_14%,transparent)] text-ink-1"
                : "border-line bg-surface-1/60 text-ink-2 hover:bg-surface-2 hover:text-ink-1"
            )}
          >
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}
