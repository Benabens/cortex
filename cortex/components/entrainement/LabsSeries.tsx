"use client";

/* eslint-disable react-hooks/set-state-in-effect -- un changement d’état du job clôt explicitement la génération */

import { useEffect, useRef, useState } from "react";
import { FlaskConical, Sparkles, ExternalLink, AlertTriangle, RotateCw } from "lucide-react";
import { Panel, SectionHeader } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { GenerationProgress } from "@/components/generation/GenerationProgress";
import { useApi, useCourse, useJob, JOB_ACTIVE, jobEnd, type ApiError, engineDown } from "@/lib/ux/api";
import { useJobError } from "@/components/generation/useJobError";
import { examLinkFromResultPath, type LabsResp } from "@/lib/ux/training";
import { UsageLine, useLaunchUsage } from "@/components/billing/UsageIndicator";
import { useTranslations } from "use-intl/react";

/**
 * Série Labs (spécifique CS-202 — le moule « Q6 2025 » sur le vrai code des labs).
 * GET /api/labs/generate → série ; POST {lab} → JOB de génération d'un exo neuf.
 */
export function LabsSeries() {
  const t = useTranslations("labsSeries");
  const apiT = useTranslations("api");
  const { courseId, course } = useCourse();
  const { data, loading, error, refetch } = useApi<LabsResp>("/api/labs/generate");

  const [activeLab, setActiveLab] = useState<string | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const job = useJob(jobId);
  const jobError = useJobError();
  const running = jobId != null && (!job || JOB_ACTIVE.includes(job.status));
  const notified = useRef(false);
  // Même verdict que POST /api/labs/generate, pour tous les boutons « Générer » de la série.
  const launch = useLaunchUsage("lab-exercise");
  const { refresh: refreshUsage } = launch;
  useEffect(() => { if (!running) refreshUsage(); }, [running, refreshUsage]);

  useEffect(() => {
    if (!job || JOB_ACTIVE.includes(job.status) || notified.current) return;
    notified.current = true;
    const end = jobEnd(job.status);
    if (end === "failed") {
      setGenError(jobError(job.error) ?? t("jobFailed"));
      setJobId(null);
      setActiveLab(null);
    } else if (end === "canceled") {
      setJobId(null);
      setActiveLab(null);
    } else {
      refetch();
    }
  }, [job, refetch, t, jobError]);

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
        const err: ApiError = { status: res.status, message: d?.error ?? apiT("httpError", { status: res.status }), code: typeof d?.code === "string" ? d.code : null, params: d?.params };
        throw err;
      }
      setJobId(d.jobId);
    } catch (e) {
      const err = e as ApiError;
      setGenError(
        engineDown(err)
          ? t("llmUnavailable")
          : err.message || t("startFailed")
      );
      setActiveLab(null);
    }
  };

  const doneLink = job && !JOB_ACTIVE.includes(job.status) ? examLinkFromResultPath(job.resultPath, courseId) : null;

  return (
    <section>
      <SectionHeader
        title={t("title")}
        hint={t("hint")}
      />
      {loading ? (
        <div
          className="grid grid-cols-1 gap-3 md:grid-cols-2"
          aria-busy="true"
          aria-label={t("loading")}
        >
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-20 rounded-lg" />
          ))}
        </div>
      ) : error || !data ? (
        <Panel className="flex flex-col items-center gap-3 rounded-xl px-6 py-8 text-center">
          <AlertTriangle className="size-5 text-danger-hi" strokeWidth={2} />
          <p className="text-[0.9rem] text-ink-2">{t("loadFailed")}</p>
          <Button variant="secondary" size="sm" onClick={refetch}>
            <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
            {t("retry")}
          </Button>
        </Panel>
      ) : (
        <>
        {!running && <UsageLine usage={launch.usage} now={launch.now} className="mb-3" />}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {data.series.map(({ lab, exams }) => {
            const isActive = activeLab === lab.id;
            return (
              <Panel key={lab.id} className="flex flex-col gap-4 p-5 sm:p-6">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="grid size-11 shrink-0 place-items-center rounded-2xl border border-line bg-surface-2/60 text-ink-3">
                    <FlaskConical className="size-[1.1rem]" strokeWidth={2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-base font-semibold text-ink-1" lang={course?.language || undefined}>{lab.label}</h3>
                    <p className="text-sm text-ink-3">
                      {exams.length > 0
                        ? t("generated", { count: exams.length })
                        : t("none")}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => generate(lab.id)}
                    loading={isActive && running}
                    disabled={(running && !isActive) || (!running && !launch.allowed)}
                  >
                    {!(isActive && running) && <Sparkles className="size-3.5" strokeWidth={2.25} />}
                    {t("generate")}
                  </Button>
                </div>
                {isActive && running && <GenerationProgress job={job} meanwhile={false} />}
                {isActive && doneLink && (
                  <a
                    href={doneLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-[0.82rem] font-medium text-emerald-hi hover:underline"
                  >
                    {t("openPdf")}
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                )}
              </Panel>
            );
          })}
        </div>
        </>
      )}
      {genError && (
        <p role="alert" className="mt-3 text-[0.84rem] text-danger-hi">
          {genError}
        </p>
      )}
    </section>
  );
}
