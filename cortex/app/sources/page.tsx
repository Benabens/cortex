"use client";

import styles from "@/app/secondary.module.css";
import { WifiOff, RotateCw, FolderOpen } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { FileManager, useReindex } from "@/components/sources/FileManager";
import { ImportPanel } from "@/components/sources/ImportPanel";
import { BackToCloudNote, CloudRetentionBanner } from "@/components/sources/OriginalsNotes";
import { Panel } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { useApi } from "@/lib/ux/api";
import type { SourcesResp } from "@/lib/ux/sources";
import { useTranslations } from "use-intl/react";

export default function SourcesPage() {
  const t = useTranslations("sources");
  const { data, loading, error, refetch } = useApi<SourcesResp>("/api/sources");
  const reindex = useReindex(refetch);

  return (
    <div className={styles.page}>
      <PageHeader
        title={t("title")}
        description={t("description")}
      />
      {data?.originals && <CloudRetentionBanner originals={data.originals} />}
      {data?.originals && <BackToCloudNote originals={data.originals} />}
      {/* Reclassement d'un fichier : annoncé sans voler le focus, et toujours monté (la liste se
          démonte pendant son rechargement). */}
      <p role="status" aria-live="polite" className={reindex.notice ? "text-[0.85rem] text-ink-2" : "sr-only"}>
        {reindex.notice}
      </p>
      <div className={styles.split}>
        {/* Skeleton UNIQUEMENT au premier chargement : un refetch (ex. coche « Référence »)
            garde la liste montée → plus de saut/remontage (fix jank). */}
        {loading && !data ? (
          <div className="skeleton h-[28rem] rounded-lg" role="status" aria-busy="true" aria-label={t("loading")} />
        ) : error ? (
          <Panel className="flex flex-col items-center justify-center gap-3 rounded-xl px-6 py-16 text-center">
            <WifiOff className="size-6 text-danger-hi" strokeWidth={2} aria-hidden="true" />
            <p className="text-[0.95rem] font-medium text-ink-1">{t("loadTitle")}</p>
            <p className="max-w-sm text-[0.85rem] leading-relaxed text-ink-3">
              {t("loadHint")}
            </p>
            <Button variant="secondary" size="sm" onClick={refetch}>
              <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
              {t("retry")}
            </Button>
          </Panel>
        ) : !data || (data.exams.length === 0 && data.corpus.length === 0) ? (
          <Panel className="flex flex-col items-center justify-center gap-3 rounded-xl px-6 py-16 text-center">
            <span className="grid size-11 place-items-center rounded-lg border border-line bg-surface-2/60 text-ink-3">
              <FolderOpen className="size-5" strokeWidth={2} />
            </span>
            <p className="text-[0.95rem] font-medium text-ink-1">{t("emptyTitle")}</p>
            <p className="max-w-sm text-[0.85rem] leading-relaxed text-ink-3">
              {t("emptyHint")}
            </p>
          </Panel>
        ) : (
          <FileManager data={data} onChanged={refetch} reindex={reindex} />
        )}
        <ImportPanel onChanged={refetch} unread={data?.unread} originals={data?.originals} />
      </div>
    </div>
  );
}
