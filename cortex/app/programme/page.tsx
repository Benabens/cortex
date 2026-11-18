"use client";

import { WifiOff, RotateCw, FolderUp } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/primitives";
import { ReanalyzeButton } from "@/components/programme/ReanalyzeButton";
import { ProgramExplorer } from "@/components/programme/ProgramExplorer";
import { useApi, useCourse } from "@/lib/ux/api";
import { buildTypes, type ProgramResp } from "@/lib/ux/program";
import { useTranslations } from "use-intl/react";

export default function ProgrammePage() {
  const t = useTranslations("programPage");
  const { course } = useCourse();
  const { data, loading, error, refetch } = useApi<ProgramResp>("/api/program");

  if (loading) return <ProgrammeSkeleton loadingLabel={t("loading")} />;

  if (error || !data) {
    return (
      <Panel className="flex flex-col items-center gap-3 rounded-xl px-6 py-12 text-center">
        <WifiOff className="size-6 text-danger-hi" strokeWidth={2} aria-hidden="true" />
        <h1 className="text-[0.95rem] font-medium tracking-normal text-ink-1">{t("loadFailed")}</h1>
        <p className="max-w-xs text-[0.85rem] leading-relaxed text-ink-3">
          {t("loadHint")}
        </p>
        <Button variant="secondary" size="sm" onClick={refetch}>
          <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
          {t("retry")}
        </Button>
      </Panel>
    );
  }

  const types = buildTypes(data.topics, t);
  const chapters = data.chapters ?? [];
  const planOk = !!data.planOk;

  // Rien d'exploitable (cours non analysé) → état qui enseigne.
  if (types.length === 0) {
    return (
      <div className="flex flex-col gap-7">
        <PageHeader
          title={t("title")}
          description={t("emptyDescription")}
        />
        {/* Recette d'état vide commune (chip 11 · 0,95rem · corps 0,85rem), cf. Examens/Sources/Faiblesses. */}
        <Panel className="flex flex-col items-center justify-center gap-3 rounded-xl px-6 py-16 text-center">
          <span className="grid size-11 place-items-center rounded-lg border border-line bg-surface-2/60 text-ink-3">
            <FolderUp className="size-5" strokeWidth={2} aria-hidden="true" />
          </span>
          <p className="text-[0.95rem] font-medium text-ink-1">{t("emptyTitle")}</p>
          <p className="max-w-sm text-[0.85rem] leading-relaxed text-ink-3">
            {t("emptyHint")}
          </p>
          <Button variant="primary" href="/sources">
            {t("addPastExams")}
          </Button>
        </Panel>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title={t("title")}
        description={t("description")}
      >
        <ReanalyzeButton onDone={refetch} />
      </PageHeader>

      <ProgramExplorer types={types} chapters={chapters} planOk={planOk} language={course?.language} />
    </div>
  );
}

function ProgrammeSkeleton({ loadingLabel }: { loadingLabel: string }) {
  return (
    <div className="flex flex-col gap-7" aria-busy="true" aria-label={loadingLabel}>
      <div>
        <div className="skeleton h-3.5 w-52" />
        <div className="skeleton mt-3 h-9 w-64" />
        <div className="skeleton mt-3 h-4 w-[30rem] max-w-full" />
      </div>
      <div className="skeleton h-11 w-56 rounded-lg" />
      <div className="flex flex-col gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-40 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
