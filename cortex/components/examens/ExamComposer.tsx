"use client";

import styles from "@/app/secondary.module.css";
import { useEffect, useRef, useState } from "react";
import { Play, Check, AlertTriangle, Clock3, SlidersHorizontal, Target, ChevronDown } from "lucide-react";
import { Panel } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { WeightBar } from "@/components/viz/WeightBar";
import { apiPost, useCourse, useJob, JOB_ACTIVE, asText, type ApiError } from "@/lib/ux/api";
import type { PlanExam, PlanQcm } from "@/lib/ux/exams";
import { cn } from "@/lib/ux/cn";
import { PaywallNotice } from "@/components/billing/PaywallNotice";

const V = "var(--color-accent)";

/**
 * Compositeur RÉEL (REFONTE ALLÉGÉE) : la PROPOSITION par défaut (format réel du final) suffit —
 * le réglage fin est REPLIÉ derrière « Ajuster la composition ». Un champ « Mets l'accent sur… »
 * (focus GÉNÉRIQUE) garantit 1-2 exos/QCM sur un thème sans monopoliser (supporté qcm ET exam).
 *  - qcm  : POST /api/qcm/generate  {count, openCount, focus} (JOB)
 *  - exam : POST /api/exams/generate {count, focus} (JOB)
 */
export function ExamComposer({ plan, onGenerated }: { plan: PlanQcm | PlanExam; onGenerated: () => void }) {
  const { courseId } = useCourse();
  const isQcm = plan.kind === "qcm";
  const q = plan as PlanQcm;
  const unit = plan.kind === "exam" ? plan.unit ?? "exercice" : "exercice";

  const [nQcm, setNQcm] = useState(isQcm ? q.qcm : 0);
  const [nOpen, setNOpen] = useState(isQcm ? q.open : 0);
  const [nExos, setNExos] = useState(!isQcm && "exercises" in plan ? plan.exercises : 6);
  const [focus, setFocus] = useState("");
  const [focusOpen, setFocusOpen] = useState(false); // P-A : « Mets l'accent sur… » replié par défaut
  const [adjust, setAdjust] = useState(false);

  const [jobId, setJobId] = useState<number | null>(null);
  const [launching, setLaunching] = useState(false);
  const [genError, setGenError] = useState<{ message: string; command?: string; paywall?: boolean } | null>(null);
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
    setFocusOpen(false);
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
      // Examen incomplet : le worker termine son étape par « ⚠ <n questions manquantes, crédits rendus> ».
      const step = asText(job.currentStep) ?? "";
      const shortfall = step.includes("⚠") ? step.slice(step.indexOf("⚠") + 1).trim() : null;
      setDoneMsg(shortfall
        ? `Examen généré, incomplet : ${shortfall}. Il apparaît dans « Examens prêts » ci-dessous.`
        : "Examen généré : il apparaît dans « Examens prêts » ci-dessous.");
      onGenerated();
    }
  }, [job, onGenerated]);

  const running = launching || (job != null && JOB_ACTIVE.includes(job.status));

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
        message: err.status === 503 ? `Le moteur LLM est injoignable : ${err.message}` : err.message || "Impossible de lancer la génération.",
        paywall: err.status === 402,
      });
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className={styles.split}>
      {/* Composer */}
      <Panel className="p-6">
        <h2 className="text-[1.2rem] font-semibold leading-tight text-ink-1">Compositeur d’examen</h2>

        {/* composition : proposition compacte (défaut) + disclosure de réglage fin */}
        <div className="mt-6 rounded-2xl border border-line bg-surface-2/40">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-5">
            <span className="text-[0.82rem] text-ink-2">Composition</span>
            <span className="font-data text-[1.02rem] font-semibold tabular text-ink-1">
              {isQcm ? (
                <>{nQcm} <span className="text-[0.78rem] font-normal text-ink-3">QCM ·</span> {nOpen} <span className="text-[0.78rem] font-normal text-ink-3">ouverte{nOpen > 1 ? "s" : ""}</span></>
              ) : (
                <>{nExos} <span className="text-[0.78rem] font-normal text-ink-3">{unit}{nExos > 1 ? "s" : ""}</span></>
              )}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setAdjust((a) => !a)}
            aria-expanded={adjust}
            className="flex w-full items-center justify-between gap-2 border-t border-line min-h-11 px-5 py-3 text-sm text-ink-3 transition-colors hover:text-ink-1"
          >
            <span className="inline-flex items-center gap-2"><SlidersHorizontal className="size-3.5" strokeWidth={2.25} /> Ajuster la composition</span>
            <ChevronDown className={cn("size-4 transition-transform", adjust && "rotate-180")} strokeWidth={2.25} />
          </button>
          {adjust && (
            <div className="border-t border-line px-4 py-4">
              {isQcm ? (
                <div className="space-y-5">
                  <SliderRow label="QCM" hint={`proposé : ${q.qcm}`} color={V} value={nQcm} max={40} onChange={setNQcm} />
                  <SliderRow label="Questions ouvertes" hint={`proposé : ${q.open}`} color={V} value={nOpen} max={12} onChange={setNOpen} />
                </div>
              ) : (
                <SliderRow label={`${unit[0].toUpperCase()}${unit.slice(1)}s`} hint={`proposé : ${"exercises" in plan ? plan.exercises : 6}`} color={V} value={nExos} min={1} max={12} onChange={setNExos} />
              )}
              <button type="button" onClick={proposal} className="mt-4 text-[0.78rem] text-ink-3 underline-offset-2 transition-colors hover:text-accent-hi hover:underline">
                Revenir à la proposition
              </button>
            </div>
          )}
        </div>

        {/* P-A — « Mets l'accent sur… » optionnel, REPLIÉ par défaut : par défaut on génère au format
            détecté, aucun champ visible, aucune pression. Ouvert seulement si on VEUT cibler un thème. */}
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setFocusOpen((o) => !o)}
            aria-expanded={focusOpen}
            aria-controls="exam-focus-panel"
            className="flex w-full items-center justify-between gap-2 min-h-11 rounded-lg px-1 py-2 text-sm text-ink-3 transition-colors hover:text-ink-1"
          >
            <span className="inline-flex min-w-0 items-center gap-2">
              <Target className="size-3.5 shrink-0" strokeWidth={2.25} />
              <span className="truncate">
                Mets l’accent sur une notion
                {!focusOpen && focus.trim() && <span className="ml-1 text-accent-hi">· {focus.trim()}</span>}
              </span>
            </span>
            <ChevronDown className={cn("size-4 shrink-0 transition-transform", focusOpen && "rotate-180")} strokeWidth={2.25} />
          </button>
          {focusOpen && (
            <div id="exam-focus-panel" className="mt-1.5">
              <input
                id="exam-focus"
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                autoFocus
                placeholder={isQcm ? "ex. régularisation, PCA, backprop…" : "ex. une notion précise à travailler"}
                className="w-full rounded-lg border border-line-strong bg-surface-2/40 px-3.5 py-2.5 text-[0.9rem] text-ink-1 placeholder:text-ink-4 focus:border-[color-mix(in_oklch,var(--color-accent)_50%,transparent)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--color-accent)_28%,transparent)]"
              />
              <p className="mt-1.5 text-[0.74rem] text-ink-4">Une notion, pas un format : 1 ou 2 questions porteront dessus, sans monopoliser l’examen.</p>
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
        <div className="mt-6 flex flex-wrap items-center gap-3">
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
        {genError?.paywall && <div className="mt-3"><PaywallNotice credits={isQcm ? 1 : 2} /></div>}
      </Panel>

      {/* Format détecté (réel) */}
      <div className="flex flex-col gap-5">
        <Panel className="p-6">
          <h2 className="text-[1.2rem] font-semibold text-ink-1">Format détecté</h2>
          <span className="mt-2 inline-flex rounded-full border border-line bg-surface-2/50 px-2.5 py-1 text-xs font-medium text-ink-2">
            {isQcm ? "QCM et questions ouvertes" : "Exercices ouverts"}
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
