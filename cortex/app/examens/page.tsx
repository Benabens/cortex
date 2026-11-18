"use client";

import styles from "@/app/secondary.module.css";
import { ExternalLink, CheckCircle2, ClipboardList, WifiOff, RotateCw, Trash2, FileText } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, SectionHeader } from "@/components/ui/primitives";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ExamComposer } from "@/components/examens/ExamComposer";
import { useApi, useCourse, asText } from "@/lib/ux/api";
import type { ComposeResp, ExamsResp } from "@/lib/ux/exams";
import { useState } from "react";
import { apiDelete } from "@/lib/ux/write";
import { useTranslations } from "use-intl/react";
import { useFmt } from "@/lib/i18n/use-fmt";

export default function ExamensPage() {
  const t = useTranslations("examsPage");
  const f = useFmt();
  const compose = useApi<ComposeResp>("/api/compose");
  const exams = useApi<ExamsResp>("/api/exams");
  const { courseId, course } = useCourse();
  const [deleting, setDeleting] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [recompiling, setRecompiling] = useState<number | null>(null);

  // PDF manquant (examen QCM) : recompilé depuis la base, sans le modèle, gratuitement.
  const recompile = async (id: number) => {
    if (recompiling) return;
    setRecompiling(id);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/exams/${id}/pdf?course=${encodeURIComponent(courseId)}`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) setDeleteError(d.error ?? t("pdfFailed"));
      exams.refetch();
    } finally {
      setRecompiling(null);
    }
  };

  const removeExam = async (id: number) => {
    if (deleting) return;
    if (!window.confirm(t("deleteConfirm", { id }))) return;
    setDeleting(id);
    setDeleteError(null);
    try {
      await apiDelete(`/api/exams?id=${id}&course=${encodeURIComponent(courseId)}`);
      exams.refetch();
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className={styles.page}>
      <PageHeader title={t("title")} description={t("description")} />

      {deleteError && (
        <p role="alert" className="text-[0.85rem] text-danger-hi">
          {t("deleteFailed", { error: deleteError })}
        </p>
      )}

      {/* Compositeur ← GET /api/compose (plan réel, forme variable selon le cours) */}
      {compose.loading ? (
        <div
          className="grid grid-cols-1 gap-5 lg:grid-cols-[1.55fr_1fr]"
          aria-busy="true"
          aria-label={t("loadingCompose")}
        >
          <div className="skeleton h-96 rounded-xl" />
          <div className="skeleton h-72 rounded-xl" />
        </div>
      ) : compose.error || !compose.data?.plan ? (
        <Panel className="flex flex-col items-center gap-3 rounded-xl px-6 py-12 text-center">
          <FileText className="size-6 text-ink-3" strokeWidth={2} />
          <p className="text-[0.95rem] font-medium text-ink-1">
            {compose.error ? t("formatUnavailable") : t("formatMissing")}
          </p>
          <p className="max-w-sm text-[0.85rem] leading-relaxed text-ink-3">
            {compose.error
              ? t("formatUnavailableHint")
              : t("formatMissingHint")}
          </p>
          {compose.error ? (
            <Button variant="secondary" size="sm" onClick={compose.refetch}>
              <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
              {t("retry")}
            </Button>
          ) : (
            <Button variant="primary" size="sm" href="/sources">
              {t("prepare")}
            </Button>
          )}
        </Panel>
      ) : compose.data.plan.kind === "unknown" ? (
        <Panel className="flex flex-col items-center gap-3 rounded-xl px-6 py-12 text-center">
          <FileText className="size-6 text-ink-3" strokeWidth={2} />
          <p className="text-[0.95rem] font-medium text-ink-1">{t("formatUnknown")}</p>
          <p className="max-w-md text-[0.85rem] leading-relaxed text-ink-3" lang={course?.language || undefined}>{compose.data.plan.summary}</p>
          <Button variant="primary" size="sm" href="/cours">
            {t("declareFormat")}
          </Button>
        </Panel>
      ) : (
        <ExamComposer plan={compose.data.plan} onGenerated={exams.refetch} />
      )}

      {/* Examens prêts ← GET /api/exams (réel ; 500 possible sur cs-202) */}
      <section>
        <SectionHeader title={t("readyTitle")} hint={t("readyHint")} />

        {exams.loading ? (
          <div
            className="grid grid-cols-1 gap-3 md:grid-cols-2"
            aria-busy="true"
            aria-label={t("loadingReady")}
          >
            {[0, 1].map((i) => (
              <div key={i} className="skeleton h-24 rounded-lg" />
            ))}
          </div>
        ) : exams.error ? (
          <Panel className="flex flex-col items-center gap-3 rounded-xl px-6 py-10 text-center">
            <WifiOff className="size-6 text-danger-hi" strokeWidth={2} />
            <p className="text-[0.95rem] font-medium text-ink-1">{t("listFailed")}</p>
            <p className="max-w-sm text-[0.85rem] text-ink-3">
              {t("listFailedHint")}
            </p>
            <Button variant="secondary" size="sm" onClick={exams.refetch}>
              <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
              {t("retry")}
            </Button>
          </Panel>
        ) : !exams.data || exams.data.exams.length === 0 ? (
          <Panel className="flex flex-col items-center gap-3 rounded-xl px-6 py-12 text-center">
            <span className="grid size-11 place-items-center rounded-lg border border-line bg-surface-2/60 text-ink-3">
              <ClipboardList className="size-5" strokeWidth={2} />
            </span>
            <p className="text-[0.95rem] font-medium text-ink-1">{t("emptyTitle")}</p>
            <p className="max-w-sm text-[0.85rem] leading-relaxed text-ink-3">
              {t("emptyHint")}
            </p>
          </Panel>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {exams.data.exams.map((e) => {
              const ready = e.status === "ready";
              const summary = asText(e.verifySummary);
              const day = f.date(e.createdAt, "short");
              return (
                <Panel key={e.id} className="flex flex-wrap items-center gap-5 p-5 sm:p-6">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-[0.95rem] font-semibold text-ink-1">
                        {/* Toujours ouvrable en ligne, PDF ou pas (examen 4 de CS-290). */}
                        {e.onlineUrl ? <a href={e.onlineUrl} className="hover:underline">{t("exam", { id: e.id })}</a> : <>{t("exam", { id: e.id })}</>}
                      </h3>
                      <Badge tone={ready ? "success" : "neutral"} Icon={ready ? CheckCircle2 : undefined} size="xs">
                        {ready ? t("ready") : e.status === "generating" ? (e.kind === "blocks" ? t("pdfRunning") : t("openRunning")) : t("incomplete")}
                      </Badge>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[0.8rem] text-ink-3" lang={summary ? course?.language || undefined : undefined}>
                      {summary ?? t("questions", { count: e.questionCount })}
                      {day ? ` · ${day}` : ""}
                    </p>
                  </div>
                  {/* Sur mobile, les actions passent sous le titre (sinon elles le recouvrent). */}
                  <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto">
                    {e.url && (
                      <a
                        href={e.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-11 items-center gap-1 rounded-full border border-line bg-surface-2/60 px-3 text-[0.8rem] font-medium text-ink-2 transition-colors hover:border-[color-mix(in_oklch,var(--color-accent)_38%,transparent)] hover:text-ink-1"
                      >
                        {t("statement")}
                        <ExternalLink className="size-3.5" aria-hidden="true" />
                      </a>
                    )}
                    {e.solutionsUrl && (
                      <a
                        href={e.solutionsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-11 items-center gap-1 rounded-full border border-line bg-surface-2/60 px-3 text-[0.8rem] font-medium text-ink-2 transition-colors hover:border-[color-mix(in_oklch,var(--color-emerald)_38%,transparent)] hover:text-ink-1"
                      >
                        {t("solution")}
                        <ExternalLink className="size-3.5" aria-hidden="true" />
                      </a>
                    )}
                    {e.pdfMissing && (
                      <button
                        type="button"
                        onClick={() => recompile(e.id)}
                        disabled={recompiling === e.id}
                        className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface-2/60 px-3 text-[0.8rem] font-medium text-ink-3 transition-colors hover:text-ink-1 disabled:opacity-50"
                      >
                        {recompiling === e.id ? t("recompiling") : t("recompile")}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => removeExam(e.id)}
                      disabled={deleting === e.id}
                      aria-label={t("delete", { id: e.id })}
                      className="grid size-11 place-items-center rounded-full border border-transparent text-ink-4 transition-colors hover:border-[color-mix(in_oklch,var(--color-danger)_35%,transparent)] hover:text-danger-hi disabled:opacity-50"
                    >
                      <Trash2 className="size-4" strokeWidth={2} />
                    </button>
                  </div>
                </Panel>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
