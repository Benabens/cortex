"use client";

import { WeightBar } from "@/components/viz/WeightBar";
import { CortexMark } from "@/components/shell/CortexMark";

/** Corps du suivi d'une génération : type, avancement, temps restant estimé (lib/eta) et étape. */
export function JobProgress({ label, progress, queued, step, eta }: { label: string | null; progress: number; queued: boolean; step: string | null; eta: string | null }) {
  return (
    <section className="panel flex flex-col gap-2.5 p-4 sm:p-5" aria-live="polite" aria-label="Génération en cours">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2.5 text-[0.9rem] font-medium text-ink-1">
          <CortexMark size={16} spinning />
          Génération en cours{label ? ` · ${label}` : ""}
        </span>
        <span className="font-data text-[0.82rem] font-semibold text-ink-2">{queued ? "En file" : `${progress} %`}</span>
      </div>
      <WeightBar pct={queued ? 4 : progress} height={6} />
      {eta && <p className="text-[0.8rem] text-ink-2">{eta}</p>}
      {step && <p className="text-[0.8rem] text-ink-3">{step}</p>}
    </section>
  );
}
