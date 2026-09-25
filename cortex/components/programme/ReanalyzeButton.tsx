"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw, Check, ScanLine, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/ux/cn";
import { apiPost, useCourse, useJob, JOB_ACTIVE, asText } from "@/lib/ux/api";

type Phase = "idle" | "running" | "done" | "error";

/**
 * Ré-analyse RÉELLE des annales : POST /api/program/analyze → job → poll
 * /api/jobs/[id]. Reprend un job d'analyse déjà actif au chargement (GET).
 * Erreur 412/503 (moteur LLM absent, corpus non ingéré) affichée clairement.
 */
export function ReanalyzeButton({ onDone }: { onDone: () => void }) {
  const { courseId } = useCourse();
  const [phase, setPhase] = useState<Phase>("idle");
  const [jobId, setJobId] = useState<number | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const job = useJob(jobId);
  const notified = useRef(false);

  // Reprise : un job d'analyse tourne peut-être déjà (reload de page).
  useEffect(() => {
    let stop = false;
    setPhase("idle");
    setJobId(null);
    setErrMsg(null);
    notified.current = false;
    fetch(`/api/program/analyze?course=${encodeURIComponent(courseId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!stop && d?.active?.id) {
          setJobId(d.active.id);
          setPhase("running");
        }
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, [courseId]);

  // Fin de job → refetch du programme.
  useEffect(() => {
    if (!job || JOB_ACTIVE.includes(job.status)) return;
    if (notified.current) return;
    notified.current = true;
    if (job.status === "error" || job.status === "failed") {
      setPhase("error");
      setErrMsg(asText(job.error) ?? "L’analyse a échoué. Réessaie.");
    } else {
      setPhase("done");
      onDone();
      setTimeout(() => setPhase("idle"), 4000);
    }
  }, [job, onDone]);

  const run = async () => {
    if (phase === "running") return;
    setErrMsg(null);
    setPhase("running");
    notified.current = false;
    try {
      const d = await apiPost<{ ok: boolean; jobId: number }>("/api/program/analyze", courseId);
      setJobId(d.jobId);
    } catch (e) {
      const err = e as { status: number | null; message: string };
      setPhase("error");
      setErrMsg(
        err.status === 503 || err.status === 412
          ? `Impossible de lancer l’analyse : ${err.message}`
          : err.message || "Impossible de lancer l’analyse."
      );
    }
  };

  const step = job && JOB_ACTIVE.includes(job.status) ? asText(job.currentStep) : null;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={run}
        disabled={phase === "running"}
        className={cn(
          "relative inline-flex h-11 items-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors",
          "focus-visible:outline-2 focus-visible:outline-violet focus-visible:outline-offset-2",
          phase === "done"
            ? "border-[color-mix(in_oklch,var(--color-emerald)_45%,transparent)] text-emerald-hi"
            : phase === "error"
              ? "border-[color-mix(in_oklch,var(--color-danger)_45%,transparent)] text-danger-hi"
              : "border-line-strong bg-surface-2 text-ink-1 edge-top hover:bg-surface-3"
        )}
      >
        {phase === "running" && <ScanLine className="size-4 animate-pulse text-cyan-hi" strokeWidth={2.25} />}
        {phase === "idle" && <RefreshCw className="size-4" strokeWidth={2.25} />}
        {phase === "done" && <Check className="size-4" strokeWidth={2.5} />}
        {phase === "error" && <AlertTriangle className="size-4" strokeWidth={2.25} />}
        <span aria-live="polite">
          {phase === "idle" && "Ré-analyser les annales"}
          {phase === "running" && (job ? `Analyse… ${job.progress} %` : "Analyse des annales…")}
          {phase === "done" && "Programme à jour"}
          {phase === "error" && "Analyse impossible"}
        </span>
      </button>
      {(step || errMsg) && (
        <p
          className={cn("max-w-xs text-right text-[0.74rem]", errMsg ? "text-danger-hi" : "text-ink-3")}
          aria-live="polite"
        >
          {errMsg ?? step}
        </p>
      )}
    </div>
  );
}
