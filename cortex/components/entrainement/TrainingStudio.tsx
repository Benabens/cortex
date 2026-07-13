"use client";

import { useEffect, useRef, useState } from "react";
import {
  Target,
  DraftingCompass,
  Sparkles,
  FileText,
  CheckSquare,
  ImagePlus,
  Gauge,
  Lightbulb,
  Eye,
  CloudOff,
  AlertTriangle,
  Check,
} from "lucide-react";
import { Panel } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { WeightBar } from "@/components/viz/WeightBar";
import { apiPost, useApi, useCourse, useJob, JOB_ACTIVE, asText, type ApiError } from "@/lib/ux/api";
import {
  FEEDBACK_OPTIONS,
  examLinkFromResultPath,
  type Drill,
  type DrillListResp,
} from "@/lib/ux/training";
import { cn } from "@/lib/ux/cn";

type Mode = "drill" | "architecte";

/**
 * Studio d'entraînement RÉEL :
 * — Drill : concept (dus / faiblesses / libre) → POST /api/drill (sync, Claude Max)
 *   → question au format examen + 5 indices progressifs + solution.
 * — Architecte : consigne et/ou image → POST /api/exercises/generate (JOB) → PDF.
 * — Retour difficulté → POST /api/feedback (vocabulaire réel du back).
 */
export function TrainingStudio() {
  const { courseId } = useCourse();
  const list = useApi<DrillListResp>("/api/drill");

  const [mode, setMode] = useState<Mode>("drill");
  const [concept, setConcept] = useState("");
  const [drill, setDrill] = useState<Drill | null>(null);
  const [drilling, setDrilling] = useState(false);
  const [shownHints, setShownHints] = useState(0);
  const [showSolution, setShowSolution] = useState(false);

  const [target, setTarget] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<File | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const [launching, setLaunching] = useState(false);
  const job = useJob(jobId);
  const jobRunning = launching || (job != null && JOB_ACTIVE.includes(job.status));
  const jobDone = job != null && !JOB_ACTIVE.includes(job.status) && job.status !== "error" && job.status !== "failed";
  const jobFailed = job != null && (job.status === "error" || job.status === "failed");

  const [error, setError] = useState<{ offline: boolean; message: string } | null>(null);
  const [fbSent, setFbSent] = useState<string | null>(null);
  const [fbBusy, setFbBusy] = useState(false);

  // reset au changement de cours
  useEffect(() => {
    setDrill(null);
    setJobId(null);
    setError(null);
    setFbSent(null);
    setConcept("");
    setShownHints(0);
    setShowSolution(false);
  }, [courseId]);

  // Deep-link ?drill=<concept> (utilisé par les boutons « Drill » des Faiblesses).
  const autolaunched = useRef(false);
  useEffect(() => {
    if (autolaunched.current) return;
    const c = new URLSearchParams(window.location.search).get("drill");
    if (c && c.trim()) {
      autolaunched.current = true;
      setMode("drill");
      setConcept(c.trim());
      launchDrill(c.trim());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function launchDrill(c?: string) {
    const chosen = (c ?? concept).trim();
    if (!chosen || drilling) return;
    setError(null);
    setDrill(null);
    setFbSent(null);
    setShownHints(0);
    setShowSolution(false);
    setDrilling(true);
    try {
      const d = await apiPost<{ ok: boolean; drill: Drill }>("/api/drill", courseId, {
        concept: chosen,
      });
      setDrill(d.drill);
    } catch (e) {
      const err = e as ApiError;
      setError({
        offline: err.status === 503,
        message:
          err.status === 503
            ? "Claude Max n’est pas joignable. Lance Cortex sur ta machine connectée, puis réessaie."
            : err.message || "La génération du drill a échoué. Réessaie.",
      });
    } finally {
      setDrilling(false);
    }
  }

  async function launchArchitect() {
    if (jobRunning) return;
    if (!target.trim() && !image) {
      setError({ offline: false, message: "Donne un sujet ou une image d’exercice." });
      return;
    }
    setError(null);
    setFbSent(null);
    setJobId(null);
    setLaunching(true);
    try {
      let res: Response;
      if (image) {
        const fd = new FormData();
        if (target.trim()) fd.append("target", target.trim());
        fd.append("image", image);
        res = await fetch(`/api/exercises/generate?course=${encodeURIComponent(courseId)}`, {
          method: "POST",
          body: fd,
        });
      } else {
        res = await fetch(`/api/exercises/generate?course=${encodeURIComponent(courseId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: target.trim() }),
        });
      }
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        const err: ApiError & { command?: string } = {
          status: res.status,
          message: d?.error ?? `Erreur ${res.status}`,
        };
        throw err;
      }
      setJobId(d.jobId);
    } catch (e) {
      const err = e as ApiError;
      setError({
        offline: err.status === 503,
        message:
          err.status === 503
            ? "Claude Max n’est pas joignable — impossible de générer pour l’instant."
            : err.message || "Impossible de lancer la génération.",
      });
    } finally {
      setLaunching(false);
    }
  }

  async function sendFeedback(verdict: string) {
    if (fbBusy || fbSent) return;
    setFbBusy(true);
    try {
      await apiPost("/api/feedback", courseId, {
        examId: jobDone ? job?.resultPath && (job as { resultId?: number }).resultId : undefined,
        topic: drill?.concept ?? (target.trim() || undefined),
        verdict,
      });
      setFbSent(verdict);
    } catch {
      /* le retour est best-effort : pas bloquant */
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
      {/* ── Composeur ── */}
      <Panel className="p-5 sm:p-6">
        <div className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-1/60 p-1">
          <ModeBtn active={mode === "drill"} onClick={() => setMode("drill")} Icon={Target}>
            Drill ciblé
          </ModeBtn>
          <ModeBtn active={mode === "architecte"} onClick={() => setMode("architecte")} Icon={DraftingCompass}>
            Architecte
          </ModeBtn>
        </div>

        {mode === "drill" ? (
          <div className="mt-4 space-y-4">
            <div>
              <label htmlFor="drill-concept" className="mb-2 block text-[0.8rem] font-medium text-ink-2">
                Concept à travailler
              </label>
              <input
                id="drill-concept"
                value={concept}
                onChange={(e) => setConcept(e.target.value)}
                placeholder="Ex. rétropropagation, max-flow, inode…"
                className="w-full rounded-lg border border-line-strong bg-surface-2/40 px-3.5 py-2.5 text-[0.9rem] text-ink-1 placeholder:text-ink-4 focus:border-[color-mix(in_oklch,var(--color-violet)_50%,transparent)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--color-violet)_28%,transparent)]"
              />
            </div>

            {list.loading ? (
              <div className="flex flex-wrap gap-2" aria-busy="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skeleton h-9 w-28 rounded-full" />
                ))}
              </div>
            ) : list.error ? (
              <p className="text-[0.8rem] text-ink-3">
                Les suggestions ne répondent pas pour ce cours — entre un concept librement.
              </p>
            ) : (
              <>
                {dueChips.length > 0 && (
                  <ChipGroup label="À réviser (dus)" chips={dueChips} onPick={(c) => setConcept(c)} selected={concept} />
                )}
                {weakChips.length > 0 && (
                  <ChipGroup label="Tes faiblesses" chips={weakChips} onPick={(c) => setConcept(c)} selected={concept} />
                )}
                {dueChips.length === 0 && weakChips.length === 0 && (
                  <p className="text-[0.8rem] text-ink-3">
                    Rien de dû pour l’instant — entre un concept librement, Cortex fera le reste.
                  </p>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <textarea
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              rows={3}
              aria-label="Consigne pour générer un exercice"
              placeholder="Décris l’exo à générer : thème précis, consigne, énoncé de référence…"
              className="w-full resize-none rounded-lg border border-line-strong bg-surface-2/40 p-3.5 text-[0.9rem] text-ink-1 placeholder:text-ink-4 focus:border-[color-mix(in_oklch,var(--color-violet)_50%,transparent)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--color-violet)_28%,transparent)]"
            />
            <label
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-5 text-center transition-colors",
                image
                  ? "border-[color-mix(in_oklch,var(--color-emerald)_45%,transparent)] bg-surface-2/50"
                  : "border-line-strong bg-surface-2/30 hover:border-[color-mix(in_oklch,var(--color-violet)_45%,transparent)] hover:bg-surface-2/50"
              )}
            >
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="sr-only"
                onChange={(e) => setImage(e.target.files?.[0] ?? null)}
              />
              <ImagePlus className={cn("size-5", image ? "text-emerald-hi" : "text-ink-3")} strokeWidth={1.75} />
              <span className="text-[0.82rem] text-ink-2">
                {image ? image.name : "Image d’énoncé à imiter (optionnelle)"}
              </span>
            </label>
          </div>
        )}

        <Button
          variant="primary"
          onClick={mode === "drill" ? () => launchDrill() : launchArchitect}
          loading={mode === "drill" ? drilling : jobRunning}
          disabled={mode === "drill" ? !concept.trim() : false}
          className="mt-5 w-full"
        >
          {!(mode === "drill" ? drilling : jobRunning) && <Sparkles className="size-4" strokeWidth={2.5} />}
          {mode === "drill"
            ? drilling
              ? "Génération du drill…"
              : "Lancer le drill"
            : jobRunning
              ? "Génération de l’exercice…"
              : "Générer l’exercice"}
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
            {error.offline ? (
              <CloudOff className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={2} />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger-hi" strokeWidth={2} />
            )}
            {error.message}
          </div>
        )}
      </Panel>

      {/* ── Résultat ── */}
      <Panel className="flex flex-col p-5 sm:p-6">
        {drill ? (
          <>
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-[0.72rem] font-medium uppercase tracking-wider text-emerald-hi">
                <span className="inline-block size-1.5 rounded-full bg-emerald" />
                Drill prêt
              </span>
              <span className="text-[0.76rem] text-ink-4">au format du final</span>
            </div>
            <h2 className="mt-3 text-[1.05rem] font-semibold text-ink-1">{drill.concept}</h2>
            <div
              className="prose-exam mt-3 text-[0.9rem] leading-relaxed text-ink-1"
              dangerouslySetInnerHTML={{ __html: drill.statement_html }}
            />

            {drill.hints.length > 0 && (
              <div className="mt-4 space-y-2">
                {drill.hints.slice(0, shownHints).map((h, i) => (
                  <div
                    key={i}
                    className="rise-in flex items-start gap-2.5 rounded-lg border border-line bg-surface-2/40 p-3 text-[0.84rem] text-ink-2"
                  >
                    <Lightbulb className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={2} />
                    <span>
                      <span className="mr-1.5 font-data text-[0.72rem] font-semibold text-ink-3">
                        {i + 1}/{drill.hints.length}
                      </span>
                      {h}
                    </span>
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
                <div
                  className="prose-exam text-[0.88rem] leading-relaxed text-ink-2"
                  dangerouslySetInnerHTML={{ __html: drill.solution_html }}
                />
              ) : (
                <Button variant="secondary" size="sm" onClick={() => setShowSolution(true)}>
                  <Eye className="size-3.5" strokeWidth={2.25} />
                  Voir la solution
                </Button>
              )}
            </div>

            <FeedbackBar onSend={sendFeedback} sent={fbSent} busy={fbBusy} />
          </>
        ) : jobRunning && job ? (
          <div className="flex flex-1 flex-col justify-center gap-3" aria-live="polite">
            <p className="text-[0.9rem] font-medium text-ink-1">
              {job.status === "queued" ? "En file d’attente…" : "Génération de l’exercice…"}
            </p>
            {asText(job.currentStep) && <p className="text-[0.82rem] text-ink-3">{asText(job.currentStep)}</p>}
            <WeightBar pct={job.status === "queued" ? 4 : job.progress} height={6} />
            <p className="font-data text-[0.82rem] font-semibold text-ink-2">
              {job.status === "queued" ? "" : `${job.progress} %`}
            </p>
          </div>
        ) : jobDone ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-[0.72rem] font-medium uppercase tracking-wider text-emerald-hi">
              <Check className="size-3.5" strokeWidth={2.5} />
              Exercice prêt
            </span>
            <h2 className="mt-3 text-[1.05rem] font-semibold text-ink-1">
              {target.trim() || "Exercice sur mesure"}
            </h2>
            <div className="mt-4 grid grid-cols-2 gap-3">
              {resultLink ? (
                <a
                  href={resultLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 p-3 transition-colors hover:border-[color-mix(in_oklch,var(--color-violet)_34%,transparent)]"
                >
                  <FileText className="size-5 text-cyan-hi" strokeWidth={2} />
                  <span className="text-[0.82rem] font-medium text-ink-1">Énoncé PDF</span>
                </a>
              ) : (
                <a
                  href="/examens"
                  className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 p-3 transition-colors hover:border-[color-mix(in_oklch,var(--color-violet)_34%,transparent)]"
                >
                  <FileText className="size-5 text-cyan-hi" strokeWidth={2} />
                  <span className="text-[0.82rem] font-medium text-ink-1">Voir dans Examens</span>
                </a>
              )}
              <a
                href="/examens"
                className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 p-3 transition-colors hover:border-[color-mix(in_oklch,var(--color-emerald)_34%,transparent)]"
              >
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
            <p className="max-w-xs text-[0.82rem] text-ink-3">
              {asText(job?.error) ?? "Réessaie — si ça persiste, vérifie Claude Max et le moteur LaTeX."}
            </p>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
            <span className="grid size-11 place-items-center rounded-lg border border-line bg-surface-2/60 text-ink-3">
              <Target className="size-5" strokeWidth={2} />
            </span>
            <p className="text-[0.92rem] font-medium text-ink-1">Ton prochain exo apparaîtra ici</p>
            <p className="max-w-xs text-[0.82rem] leading-relaxed text-ink-3">
              Choisis un concept à driller (question + indices progressifs) ou décris un exo
              sur mesure — toujours au format du vrai final.
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}

function FeedbackBar({
  onSend,
  sent,
  busy,
}: {
  onSend: (verdict: string) => void;
  sent: string | null;
  busy: boolean;
}) {
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
      {sent && (
        <p className="mt-2 text-[0.78rem] text-emerald-hi" aria-live="polite">
          Merci — Cortex recalibre la difficulté des prochains exos.
        </p>
      )}
    </div>
  );
}

function ChipGroup({
  label,
  chips,
  onPick,
  selected,
}: {
  label: string;
  chips: string[];
  onPick: (c: string) => void;
  selected: string;
}) {
  return (
    <div>
      <div className="mb-2 text-[0.72rem] font-medium uppercase tracking-wider text-ink-4">{label}</div>
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

function ModeBtn({
  active,
  onClick,
  Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-md px-3.5 text-[0.85rem] font-medium transition-colors",
        active ? "bg-surface-2 text-ink-1 ring-1 ring-line-strong" : "text-ink-3 hover:text-ink-1"
      )}
    >
      <Icon className="size-4" strokeWidth={2} />
      {children}
    </button>
  );
}
