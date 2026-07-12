"use client";

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { asText, useJob, JOB_ACTIVE, type Job } from "@/lib/ux/api";
import { WeightBar } from "@/components/viz/WeightBar";

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
  const current: Pick<Job, "status" | "progress"> & { type: unknown; currentStep: unknown } =
    job ?? initial;

  const doneNotified = useRef(false);
  useEffect(() => {
    if (job && !JOB_ACTIVE.includes(job.status) && !doneNotified.current) {
      doneNotified.current = true;
      onDone();
    }
  }, [job, onDone]);

  if (job && !JOB_ACTIVE.includes(job.status)) return null;

  const label = asText(current.type);
  const step = asText(current.currentStep);
  const queued = current.status === "queued";

  return (
    <section
      className="panel flex flex-col gap-2.5 p-4 rise-in sm:p-5"
      aria-live="polite"
      aria-label="Génération en cours"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2.5 text-[0.9rem] font-medium text-ink-1">
          <Loader2 className="size-4 animate-spin text-violet-hi" strokeWidth={2.25} aria-hidden="true" />
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
