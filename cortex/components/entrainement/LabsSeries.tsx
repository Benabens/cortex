"use client";

import { useEffect, useRef, useState } from "react";
import { FlaskConical, Sparkles, ExternalLink, AlertTriangle, RotateCw } from "lucide-react";
import { Panel, SectionHeader } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { WeightBar } from "@/components/viz/WeightBar";
import { useApi, useCourse, useJob, JOB_ACTIVE, asText, type ApiError } from "@/lib/ux/api";
import { examLinkFromResultPath, type LabsResp } from "@/lib/ux/training";

/**
 * Série Labs (spécifique CS-202 — le moule « Q6 2025 » sur le vrai code des labs).
 * GET /api/labs/generate → série ; POST {lab} → JOB de génération d'un exo neuf.
 */
export function LabsSeries() {
  const { courseId } = useCourse();
  const { data, loading, error, refetch } = useApi<LabsResp>("/api/labs/generate");

  const [activeLab, setActiveLab] = useState<string | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const job = useJob(jobId);
  const running = jobId != null && (!job || JOB_ACTIVE.includes(job.status));
  const notified = useRef(false);

  useEffect(() => {
    if (!job || JOB_ACTIVE.includes(job.status) || notified.current) return;
    notified.current = true;
    if (job.status === "error" || job.status === "failed") {
      setGenError(asText(job.error) ?? "La génération de l’exo Labs a échoué.");
      setJobId(null);
      setActiveLab(null);
    } else {
      refetch();
    }
  }, [job, refetch]);

  const generate = async (labId: string) => {
    if (running) return;
    setGenError(null);
    setActiveLab(labId);
    notified.current = false;
    try {
      const res = await fetch(`/api/labs/generate?course=${encodeURIComponent(courseId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lab: labId }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        const err: ApiError = { status: res.status, message: d?.error ?? `Erreur ${res.status}` };
        throw err;
      }
      setJobId(d.jobId);
    } catch (e) {
      const err = e as ApiError;
      setGenError(
        err.status === 503
          ? "Le moteur LLM est injoignable — impossible de générer un exo Labs pour l’instant."
          : err.message || "Impossible de lancer la génération."
      );
      setActiveLab(null);
    }
  };

  const doneLink = job && !JOB_ACTIVE.includes(job.status) ? examLinkFromResultPath(job.resultPath, courseId) : null;

  return (
    <section>
      <SectionHeader
        title="Série Labs"
        hint="Les 8 % Labs du final : un exo neuf au moule Q6 2025, sur le vrai code de tes labs."
      />
      {loading ? (
        <div
          className="grid grid-cols-1 gap-3 md:grid-cols-2"
          aria-busy="true"
          aria-label="Chargement de la série Labs"
        >
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-20 rounded-lg" />
          ))}
        </div>
      ) : error || !data ? (
        <Panel className="flex flex-col items-center gap-3 rounded-xl px-6 py-8 text-center">
          <AlertTriangle className="size-5 text-danger-hi" strokeWidth={2} />
          <p className="text-[0.9rem] text-ink-2">La série Labs ne répond pas.</p>
          <Button variant="secondary" size="sm" onClick={refetch}>
            <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
            Réessayer
          </Button>
        </Panel>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {data.series.map(({ lab, exams }) => {
            const isActive = activeLab === lab.id;
            return (
              <Panel key={lab.id} className="flex flex-col gap-3 p-4">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-line bg-surface-2/60 text-cyan-hi">
                    <FlaskConical className="size-[1.1rem]" strokeWidth={2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-[0.9rem] font-semibold text-ink-1">{lab.label}</h3>
                    <p className="text-[0.76rem] text-ink-3">
                      {exams.length > 0
                        ? `${exams.length} exo${exams.length > 1 ? "s" : ""} généré${exams.length > 1 ? "s" : ""}`
                        : "Aucun exo généré pour l’instant"}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => generate(lab.id)}
                    loading={isActive && running}
                    disabled={running && !isActive}
                  >
                    {!(isActive && running) && <Sparkles className="size-3.5" strokeWidth={2.25} />}
                    Générer
                  </Button>
                </div>
                {isActive && running && job && (
                  <div aria-live="polite">
                    <WeightBar pct={job.status === "queued" ? 4 : job.progress} height={5} />
                    {asText(job.currentStep) && (
                      <p className="mt-1.5 text-[0.74rem] text-ink-3">{asText(job.currentStep)}</p>
                    )}
                  </div>
                )}
                {isActive && doneLink && (
                  <a
                    href={doneLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-[0.82rem] font-medium text-emerald-hi hover:underline"
                  >
                    Exo prêt — ouvrir le PDF
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                )}
              </Panel>
            );
          })}
        </div>
      )}
      {genError && (
        <p role="alert" className="mt-3 text-[0.84rem] text-danger-hi">
          {genError}
        </p>
      )}
    </section>
  );
}
