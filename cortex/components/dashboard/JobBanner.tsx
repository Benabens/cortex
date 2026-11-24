"use client";

import { useEffect, useRef, useState } from "react";
import { asText, useJob, useCourse, jobEnd, type Job } from "@/lib/ux/api";
import { JobProgress } from "@/components/dashboard/JobProgress";
import { useTranslations } from "use-intl/react";

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
  const t = useTranslations("dashboard");
  const job = useJob(initial.id);
  const { courseId } = useCourse();
  const current: Pick<Job, "status" | "progress"> & { type: unknown; currentStep: unknown } =
    job ?? initial;

  const end = job ? jobEnd(job.status) : null;
  const terminal = end !== null;
  // Une annulation n'est pas un échec : le bandeau disparaît comme après un succès.
  const failed = end === "failed";

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
  // Succès ou annulation → la bannière disparaît (comportement historique). Un ÉCHEC reste
  // visible avec son message : avant, le job échouait en silence.
  if (terminal && !failed) return null;

  if (failed) {
    const rawError = asText(job!.error);
    const errMsg = rawError === "jobNotFound" ? t("jobNotFound") : rawError === "jobConnectionLost" ? t("jobConnectionLost") : rawError ?? t("generationFailedDefault");
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
        aria-label={t("generationFailedLabel")}
        style={{ borderColor: "color-mix(in oklch, var(--color-danger) 45%, var(--color-line))" }}
      >
        <div className="flex items-center justify-between gap-3">
          <span
            className="inline-flex items-center gap-2.5 text-[0.9rem] font-medium"
            style={{ color: "var(--color-danger)" }}
          >
            <span aria-hidden>⚠</span>
            {t("generationFailed", { type: asText(current.type) ?? "empty" })}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={retry}
              disabled={retrying}
              className="rounded-full border border-line-strong px-3 py-1 text-[0.8rem] font-semibold text-ink-1 disabled:opacity-50"
            >
              {retrying ? t("retrying") : t("retry")}
            </button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="rounded-full px-3 py-1 text-[0.8rem] font-medium text-ink-3 hover:text-ink-1"
            >
              {t("close")}
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
  const eta = asText((job as { eta?: unknown } | null)?.eta);

  return <JobProgress label={label} progress={current.progress} queued={queued} step={step} eta={eta} />;
}
