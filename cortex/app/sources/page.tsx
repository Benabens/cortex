"use client";

import { WifiOff, RotateCw, FolderOpen } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { FileManager } from "@/components/sources/FileManager";
import { ImportPanel } from "@/components/sources/ImportPanel";
import { Panel } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { useApi } from "@/lib/ux/api";
import type { SourcesResp } from "@/lib/ux/sources";

export default function SourcesPage() {
  const { data, loading, error, refetch } = useApi<SourcesResp>("/api/sources");

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title="Sources"
        description="Le corpus qui nourrit Cortex : tes annales, séries et slides. Importe, puis prépare le cours."
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.55fr_1fr]">
        {/* Skeleton UNIQUEMENT au premier chargement : un refetch (ex. coche « Référence »)
            garde la liste montée → plus de saut/remontage (fix jank). */}
        {loading && !data ? (
          <div className="skeleton h-[28rem] rounded-lg" aria-busy="true" aria-label="Chargement du corpus" />
        ) : error ? (
          <Panel className="flex flex-col items-center justify-center gap-3 rounded-xl px-6 py-16 text-center">
            <WifiOff className="size-6 text-danger-hi" strokeWidth={2} />
            <p className="text-[0.95rem] font-medium text-ink-1">Le corpus ne répond pas</p>
            <p className="max-w-sm text-[0.85rem] leading-relaxed text-ink-3">
              Impossible de lister les sources de ce cours. Réessaie — si ça persiste,
              le cours n’a peut-être pas encore de corpus ingéré.
            </p>
            <Button variant="secondary" size="sm" onClick={refetch}>
              <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
              Réessayer
            </Button>
          </Panel>
        ) : !data || data.exams.length === 0 ? (
          <Panel className="flex flex-col items-center justify-center gap-3 rounded-xl px-6 py-16 text-center">
            <span className="grid size-11 place-items-center rounded-lg border border-line bg-surface-2/60 text-ink-3">
              <FolderOpen className="size-5" strokeWidth={2} />
            </span>
            <p className="text-[0.95rem] font-medium text-ink-1">Aucune annale importée</p>
            <p className="max-w-sm text-[0.85rem] leading-relaxed text-ink-3">
              Dépose tes examens des dernières années dans la zone d’import : ils deviennent
              les gabarits sur lesquels Cortex cale le format de tes blancs.
            </p>
          </Panel>
        ) : (
          <FileManager data={data} onChanged={refetch} />
        )}
        <ImportPanel onChanged={refetch} />
      </div>
    </div>
  );
}
