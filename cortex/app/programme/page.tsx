"use client";

import { WifiOff, RotateCw, FolderUp } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/primitives";
import { ReanalyzeButton } from "@/components/programme/ReanalyzeButton";
import { ProgramExplorer } from "@/components/programme/ProgramExplorer";
import { useApi } from "@/lib/ux/api";
import { buildTypes, type ProgramResp } from "@/lib/ux/program";

export default function ProgrammePage() {
  const { data, loading, error, refetch } = useApi<ProgramResp>("/api/program");

  if (loading) return <ProgrammeSkeleton />;

  if (error || !data) {
    return (
      <Panel className="mx-auto mt-10 flex max-w-md flex-col items-center gap-4 p-8 text-center">
        <span className="grid size-12 place-items-center rounded-full border border-line bg-surface-2/60 text-danger-hi">
          <WifiOff className="size-5" strokeWidth={2} aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-[1.15rem] font-semibold">Impossible de charger le programme</h1>
          <p className="mt-1.5 text-[0.88rem] leading-relaxed text-ink-3">
            Le moteur ne répond pas pour ce cours. Réessaie, ou change de cours.
          </p>
        </div>
        <Button variant="secondary" onClick={refetch}>
          <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
          Réessayer
        </Button>
      </Panel>
    );
  }

  const types = buildTypes(data.topics);

  // Rien d'exploitable (cours non analysé) → état qui enseigne.
  if (types.length === 0) {
    return (
      <div className="flex flex-col gap-7">
        <PageHeader
          title="Programme"
          description="Les notions qui tombent aux finals, extraites des annales."
        />
        <Panel className="flex flex-col items-center gap-4 p-10 text-center">
          <span className="grid size-12 place-items-center rounded-full border border-line bg-surface-2/60 text-violet-hi">
            <FolderUp className="size-5" strokeWidth={2} aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-[1.1rem] font-semibold">Aucune notion analysée pour ce cours</h2>
            <p className="mx-auto mt-1.5 max-w-sm text-[0.88rem] leading-relaxed text-ink-3">
              Importe les annales, puis lance « Ré-analyser les annales » : Cortex lit chaque final et
              en extrait les notions qui tombent, avec les liens vers l’examen et le cours.
            </p>
          </div>
          <Button variant="primary" href="/sources">
            Ajouter des annales
          </Button>
        </Panel>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title="Programme"
        description="Les notions qui tombent aux finals, extraites des annales. Trie-les par section du cours ou par ce qui tombe le plus souvent — chaque notion pointe vers le final et le passage de cours."
      >
        <ReanalyzeButton onDone={refetch} />
      </PageHeader>

      <ProgramExplorer types={types} />
    </div>
  );
}

function ProgrammeSkeleton() {
  return (
    <div className="flex flex-col gap-7" aria-busy="true" aria-label="Chargement du programme">
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
