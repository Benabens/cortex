"use client";

import { Route, WifiOff, RotateCw, FolderUp } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/primitives";
import { ReanalyzeButton } from "@/components/programme/ReanalyzeButton";
import { PrioritySpotlight } from "@/components/programme/PrioritySpotlight";
import { ProgramExplorer } from "@/components/programme/ProgramExplorer";
import { useApi } from "@/lib/ux/api";
import { buildSections, flatten, stakeSharePct, type ProgramResp } from "@/lib/ux/program";

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

  const sections = buildSections(data.topics);
  const flat = flatten(sections);

  // Rien d'exploitable (cours non analysé ou données corrompues) → état qui enseigne.
  if (flat.length === 0) {
    return (
      <div className="flex flex-col gap-7">
        <PageHeader
          title="Programme"
          description="Le syllabus du cours, déduit des annales et pondéré par ce qui tombe vraiment à l’examen."
        />
        <Panel className="flex flex-col items-center gap-4 p-10 text-center">
          <span className="grid size-12 place-items-center rounded-full border border-line bg-surface-2/60 text-violet-hi">
            <FolderUp className="size-5" strokeWidth={2} aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-[1.1rem] font-semibold">Aucun programme pour ce cours</h2>
            <p className="mx-auto mt-1.5 max-w-sm text-[0.88rem] leading-relaxed text-ink-3">
              Cortex n’a pas encore de syllabus exploitable ici. Importe les annales puis
              lance la préparation : il en déduira les types d’exos et leur poids.
            </p>
          </div>
          <Button variant="primary" href="/sources">
            Préparer le cours
          </Button>
        </Panel>
      </div>
    );
  }

  const stakeShare = stakeSharePct(flat);
  const stats = [
    { label: "Maîtrise pondérée", value: `${data.stats.masteryPct} %`, sub: `sur ${data.stats.total} types`, tone: "text-ink-1" },
    { label: "Programme couvert", value: `${data.stats.covered}/${data.stats.total}`, sub: `${flat.filter((t) => t.status === "JAMAIS_VU").length} jamais vus`, tone: "text-ink-1" },
    { label: "Examen en jeu", value: `${stakeShare} %`, sub: "encore à prendre", tone: "text-violet-hi" },
    { label: "Types solides", value: `${data.stats.mastered}`, sub: "maîtrisés", tone: "text-emerald-hi" },
  ];

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title="Programme"
        description="Le syllabus du cours, trié par ce qui rapporte le plus à l’examen. Chaque type est pondéré par les annales."
      >
        <Button variant="primary" href="/entrainement">
          <Route className="size-4" strokeWidth={2.5} />
          Lancer un parcours
        </Button>
        <ReanalyzeButton onDone={refetch} />
      </PageHeader>

      {/* summary strip — chiffres réels de /api/program (stake dérivé, cf. MAPPING) */}
      <Panel className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-line p-0 md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-surface-1 px-5 py-4">
            <div className="text-[0.68rem] font-medium uppercase tracking-wider text-ink-3">{s.label}</div>
            <div className={`mt-1.5 font-data text-[1.7rem] font-semibold leading-none ${s.tone}`}>{s.value}</div>
            <div className="mt-1 text-[0.75rem] text-ink-3">{s.sub}</div>
          </div>
        ))}
      </Panel>

      <PrioritySpotlight types={flat} maxWeight={Math.max(...flat.map((t) => t.weightPct), 1)} />

      <ProgramExplorer sections={sections} />
    </div>
  );
}

function ProgrammeSkeleton() {
  return (
    <div className="flex flex-col gap-7" aria-busy="true" aria-label="Chargement du programme">
      <div>
        <div className="skeleton h-3.5 w-52" />
        <div className="skeleton mt-3 h-9 w-64" />
        <div className="skeleton mt-3 h-4 w-[28rem] max-w-full" />
      </div>
      <div className="skeleton h-24 rounded-xl" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-48 rounded-xl" />
        ))}
      </div>
      <div className="flex flex-col gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-56 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
