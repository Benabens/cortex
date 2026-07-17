"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Wand2, ScrollText, Check, AlertTriangle, Clock3, SlidersHorizontal, Target, ChevronDown } from "lucide-react";
import { Panel } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { WeightBar } from "@/components/viz/WeightBar";
import { apiPost, useCourse, useJob, JOB_ACTIVE, asText, type ApiError } from "@/lib/ux/api";
import type { Plan, PlanQcm } from "@/lib/ux/exams";
import { cn } from "@/lib/ux/cn";

const V = "var(--color-violet)";
const C = "var(--color-cyan)";

/**
 * Compositeur RÉEL (REFONTE ALLÉGÉE) : la PROPOSITION par défaut (format réel du final) suffit —
 * le réglage fin est REPLIÉ derrière « Ajuster la composition ». Un champ « Mets l'accent sur… »
 * (focus GÉNÉRIQUE) garantit 1-2 exos/QCM sur un thème sans monopoliser (supporté qcm ET exam).
 *  - qcm  : POST /api/qcm/generate  {count, openCount, focus} (JOB)
 *  - exam : POST /api/exams/generate {count, focus} (JOB)
 */
export function ExamComposer({ plan, onGenerated }: { plan: Plan; onGenerated: () => void }) {
  const { courseId } = useCourse();
  const isQcm = plan.kind === "qcm";
  const q = plan as PlanQcm;

  const [nQcm, setNQcm] = useState(isQcm ? q.qcm : 0);
  const [nOpen, setNOpen] = useState(isQcm ? q.open : 0);
  const [nExos, setNExos] = useState(!isQcm && "exercises" in plan ? plan.exercises : 6);
  const [focus, setFocus] = useState("");
  const [adjust, setAdjust] = useState(false);

  const [jobId, setJobId] = useState<number | null>(null);
  const [launching, setLaunching] = useState(false);
  const [genError, setGenError] = useState<{ message: string; command?: string } | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);
  const job = useJob(jobId);
  const notified = useRef(false);

  const proposal = () => {
    if (isQcm) { setNQcm(q.qcm); setNOpen(q.open); }
    else if ("exercises" in plan) setNExos(plan.exercises);
  };

  // réinitialise quand le cours / plan change
  useEffect(() => {
    setNQcm(isQcm ? q.qcm : 0);
    setNOpen(isQcm ? q.open : 0);
    if (!isQcm && "exercises" in plan) setNExos(plan.exercises);
    setFocus("");
    setAdjust(false);
    setJobId(null);
    setGenError(null);
    setDoneMsg(null);
    notified.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, plan.kind]);

  // fin de job → refetch des examens prêts
  useEffect(() => {
    if (!job || JOB_ACTIVE.includes(job.status) || notified.current) return;
    notified.current = true;
    setJobId(null);
    if (job.status === "error" || job.status === "failed") {
      setGenError({ message: asText(job.error) ?? "La génération a échoué. Réessaie." });
    } else {
      setDoneMsg("Examen généré — il apparaît dans « Examens prêts » ci-dessous.");
      onGenerated();
    }
  }, [job, onGenerated]);

  const running = launching || (job != null && JOB_ACTIVE.includes(job.status));
  const totalCount = isQcm ? nQcm + nOpen : nExos;

  const generate = async () => {
    if (running) return;
    setGenError(null);
    setDoneMsg(null);
    notified.current = false;
    if (isQcm && nQcm === 0 && nOpen === 0) {
      setGenError({ message: "Composition vide : choisis au moins 1 QCM ou 1 question ouverte." });
      return;
    }
    const foc = focus.trim() || undefined;
    setLaunching(true);
    try {
      const d = isQcm
        ? await apiPost<{ ok: boolean; jobId: number }>("/api/qcm/generate", courseId, { count: nQcm, openCount: nOpen, focus: foc })
        : await apiPost<{ ok: boolean; jobId: number }>("/api/exams/generate", courseId, { count: nExos, focus: foc });
      setJobId(d.jobId);
    } catch (e) {
      const err = e as ApiError & { command?: string };
      setGenError({
        message: err.status === 503 ? `Claude Max n’est pas joignable — ${err.message}` : err.message || "Impossible de lancer la génération.",
      });
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.55fr_1fr]">
      {/* Composer */}
      <Panel className="p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <Wand2 className="size-4 text-violet-hi" strokeWidth={2.5} />
          <h2 className="text-[1.05rem] font-semibold text-ink-1">Compositeur d’examen</h2>
        </div>
        <p className="mt-1 text-[0.88rem] text-ink-2">
          «&nbsp;Un examen qui aurait pu tomber.&nbsp;» La proposition par défaut est au format réel du final — prête à lancer.
        </p>

        {/* champ FOCUS générique — « Mets l'accent sur… » */}
        <div className="mt-5">
          <label htmlFor="exam-focus" className="mb-1.5 flex items-center gap-2 text-[0.82rem] font-medium text-ink-1">
            <Target className="size-3.5 text-violet-hi" strokeWidth={2.25} />
            Mets l’accent sur… <span className="font-normal text-ink-4">(optionnel)</span>
          </label>
          <input
            id="exam-focus"
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            placeholder={isQcm ? "ex. régularisation, PCA, backprop…" : "ex. un thème précis à travailler"}
            className="w-full rounded-lg border border-line-strong bg-surface-2/40 px-3.5 py-2.5 text-[0.9rem] text-ink-1 placeholder:text-ink-4 focus:border-[color-mix(in_oklch,var(--color-violet)_50%,transparent)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--color-violet)_28%,transparent)]"
          />
          <p className="mt-1.5 text-[0.74rem] text-ink-4">1-2 exercices porteront dessus, sans monopoliser l’examen.</p>
        </div>

        {/* composition : proposition compacte (défaut) + disclosure de réglage fin */}
        <div className="mt-5 rounded-lg border border-line bg-surface-2/40">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-[0.82rem] text-ink-2">Composition</span>
            <span className="font-data text-[1.02rem] font-semibold tabular text-ink-1">
              {isQcm ? (
                <>{nQcm} <span className="text-[0.78rem] font-normal text-ink-3">QCM ·</span> {nOpen} <span className="text-[0.78rem] font-normal text-ink-3">ouverte{nOpen > 1 ? "s" : ""}</span></>
              ) : (
                <>{nExos} <span className="text-[0.78rem] font-normal text-ink-3">exercice{nExos > 1 ? "s" : ""}</span></>
              )}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setAdjust((a) => !a)}
            aria-expanded={adjust}
            className="flex w-full items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-[0.8rem] text-ink-3 transition-colors hover:text-ink-1"
          >
            <span className="inline-flex items-center gap-2"><SlidersHorizontal className="size-3.5" strokeWidth={2.25} /> Ajuster la composition</span>
            <ChevronDown className={cn("size-4 transition-transform", adjust && "rotate-180")} strokeWidth={2.25} />
          </button>
          {adjust && (
            <div className="border-t border-line px-4 py-4">
              {isQcm ? (
                <div className="space-y-5">
                  <SliderRow label="QCM" hint={`proposé : ${q.qcm}`} color={V} value={nQcm} max={40} onChange={setNQcm} />
                  <SliderRow label="Questions ouvertes" hint={`proposé : ${q.open}`} color={C} value={nOpen} max={12} onChange={setNOpen} />
                </div>
              ) : (
                <SliderRow label="Exercices" hint={`proposé : ${"exercises" in plan ? plan.exercises : 6}`} color={V} value={nExos} min={1} max={12} onChange={setNExos} />
              )}
              <button type="button" onClick={proposal} className="mt-4 text-[0.78rem] text-ink-3 underline-offset-2 transition-colors hover:text-violet-hi hover:underline">
                Revenir à la proposition
              </button>
            </div>
          )}
        </div>

        {/* progression du job */}
        {running && job && (
          <div className="mt-4 rounded-lg border border-line bg-surface-2/30 px-4 py-3" aria-live="polite">
            <div className="mb-2 flex items-center justify-between text-[0.8rem]">
              <span className="text-ink-2">{job.status === "queued" ? "En file d’attente…" : asText(job.currentStep) ?? "Génération en cours…"}</span>
              <span className="font-data font-semibold text-ink-1">{job.status === "queued" ? "" : `${job.progress} %`}</span>
            </div>
            <WeightBar pct={job.status === "queued" ? 4 : job.progress} height={6} />
          </div>
        )}

        {/* action unique */}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={generate} loading={running}>
            {!running && <Play className="size-4" strokeWidth={2.5} fill="currentColor" />}
            {running ? "Génération…" : "Générer l’examen"}
          </Button>
          {doneMsg && (
            <span className="inline-flex items-center gap-1.5 text-[0.82rem] text-emerald-hi" aria-live="polite">
              <Check className="size-4" strokeWidth={2.5} /> {doneMsg}
            </span>
          )}
        </div>
        {genError && (
          <div role="alert" className="mt-3 flex items-start gap-2.5 rounded-lg border border-[color-mix(in_oklch,var(--color-danger)_38%,transparent)] bg-[color-mix(in_oklch,var(--color-danger)_8%,transparent)] p-3 text-[0.84rem] leading-relaxed text-ink-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger-hi" strokeWidth={2} />
            <span>
              {genError.message}
              {genError.command && <code className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.78rem] text-ink-1">{genError.command}</code>}
            </span>
          </div>
        )}
      </Panel>

      {/* Format détecté (réel) */}
      <div className="flex flex-col gap-5">
        <Panel className="p-5">
          <div className="flex items-center gap-2">
            <ScrollText className="size-4 text-cyan-hi" strokeWidth={2.25} />
            <h2 className="text-[0.95rem] font-semibold text-ink-1">Format détecté</h2>
          </div>
          <span className="mt-2 inline-flex rounded-full border border-line bg-surface-2/50 px-2.5 py-1 text-[0.72rem] font-medium text-cyan-hi">
            {isQcm ? "QCM + OUVERT" : "EXERCICES OUVERTS"}
          </span>
          <p className="mt-3 text-[0.85rem] leading-relaxed text-ink-2">{plan.summary}</p>

          <div className="mt-4 space-y-2 border-t border-line pt-4">
            <div className="flex items-center justify-between text-[0.82rem]">
              <span className="inline-flex items-center gap-2 text-ink-2"><Clock3 className="size-3.5 text-ink-3" strokeWidth={2.25} /> Durée</span>
              <span className="font-data tabular text-ink-1">{plan.durationMin} <span className="text-ink-3">min</span></span>
            </div>
            <div className="flex items-center justify-between text-[0.82rem]">
              <span className="text-ink-2">Total</span>
              <span className="font-data tabular text-ink-1">{plan.totalPoints} <span className="text-ink-3">pts</span></span>
            </div>
            {isQcm && (
              <div className="flex items-center justify-between text-[0.82rem]">
                <span className="text-ink-2">Proposition</span>
                <span className="font-data tabular text-ink-1">{q.qcm} <span className="text-ink-3">QCM ·</span> {q.open} <span className="text-ink-3">ouvertes</span></span>
              </div>
            )}
            {!isQcm && "categories" in plan && plan.categories.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {plan.categories.map((c) => (
                  <span key={c} className="rounded-full border border-line bg-surface-1/60 px-2 py-0.5 text-[0.7rem] text-ink-3">{c}</span>
                ))}
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function SliderRow({
  label,
  hint,
  color,
  value,
  onChange,
  min = 0,
  max,
}: {
  label: string;
  hint: string;
  color: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max: number;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[0.88rem] text-ink-1">
          <span className="inline-block size-2.5 rounded-full" style={{ background: color }} />
          {label}
          <span className="text-[0.76rem] text-ink-4">· {hint}</span>
        </span>
        <span className="font-data text-[0.95rem] font-semibold tabular text-ink-1">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={`Nombre de ${label.toLowerCase()}`}
        className="slider"
        style={{ ["--fill" as string]: `${((value - min) / (max - min)) * 100}%` }}
      />
    </div>
  );
}
