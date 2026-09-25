"use client";

import { useEffect, useRef, useState } from "react";
import { asText, useJob, useCourse, JOB_ACTIVE, type Job } from "@/lib/ux/api";
import { WeightBar } from "@/components/viz/WeightBar";
import { CortexMark } from "@/components/shell/CortexMark";

/**
 * Bannière « génération en cours » — poll GET /api/jobs/[id] jusqu'au statut
 * terminal, puis notifie le parent (refetch du dashboard). Champs texte coercés.
 */
export function JobBanner({
  initial,
  onDone,
}: {
  initial: { id: number; type: unknown; status: string; progress: number; currentStep: unknown };
  onDone: () => void;
}) {
  const job = useJob(initial.id);
  const { courseId } = useCourse();
  const current: Pick<Job, "status" | "progress"> & { type: unknown; currentStep: unknown } =
    job ?? initial;

  const terminal = !!job && !JOB_ACTIVE.includes(job.status);
  const failed = terminal && job!.status !== "done"; // "error" | "canceled"

  const doneNotified = useRef(false);
  useEffect(() => {
    if (terminal && !doneNotified.current) {
      doneNotified.current = true;
      onDone();
    }
  }, [terminal, onDone]);

  const [dismissed, setDismissed] = useState(false);
  const [retrying, setRetrying] = useState(false);

  if (dismissed) return null;
  // Succès → la bannière disparaît (comportement historique). Un ÉCHEC reste
  // visible avec son message : avant, le job échouait en silence.
  if (terminal && !failed) return null;

  if (failed) {
    const errMsg = asText(job!.error) ?? "La génération a échoué.";
    const retry = async () => {
      setRetrying(true);
      try {
        await fetch(`/api/jobs/${initial.id}/retry?course=${encodeURIComponent(courseId)}`, {
          method: "POST",
        });
      } catch {
        /* échec réseau du retry : le parent refetch reflétera l'état réel */
      }
      setRetrying(false);
      onDone();
      setDismissed(true); // le nouveau job (s'il a démarré) réapparaîtra via le refetch parent
    };
    return (
      <section
        className="panel flex flex-col gap-2.5 p-4 sm:p-5"
        role="alert"
        aria-label="Échec de génération"
        style={{ borderColor: "color-mix(in oklch, var(--color-danger) 45%, var(--color-line))" }}
      >
        <div className="flex items-center justify-between gap-3">
          <span
            className="inline-flex items-center gap-2.5 text-[0.9rem] font-medium"
            style={{ color: "var(--color-danger)" }}
          >
            <span aria-hidden>⚠</span>
            Génération échouée{asText(current.type) ? ` · ${asText(current.type)}` : ""}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={retry}
              disabled={retrying}
              className="rounded-full border border-line-strong px-3 py-1 text-[0.8rem] font-semibold text-ink-1 disabled:opacity-50"
            >
              {retrying ? "Relance…" : "Réessayer"}
            </button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="rounded-full px-3 py-1 text-[0.8rem] font-medium text-ink-3 hover:text-ink-1"
            >
              Fermer
            </button>
          </div>
        </div>
        <p className="text-[0.82rem] leading-relaxed text-ink-2">{errMsg}</p>
      </section>
    );
  }

  const label = asText(current.type);
  const step = asText(current.currentStep);
  const queued = current.status === "queued";

  return (
    <section
      className="panel flex flex-col gap-2.5 p-4 sm:p-5"
      aria-live="polite"
      aria-label="Génération en cours"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2.5 text-[0.9rem] font-medium text-ink-1">
          <CortexMark size={16} spinning />
          Génération en cours{label ? ` · ${label}` : ""}
        </span>
        <span className="font-data text-[0.82rem] font-semibold text-ink-2">
          {queued ? "En file" : `${current.progress} %`}
        </span>
      </div>
      <WeightBar pct={queued ? 4 : current.progress} height={6} />
      {step && <p className="text-[0.8rem] text-ink-3">{step}</p>}
    </section>
  );
}
