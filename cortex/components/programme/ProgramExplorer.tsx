"use client";

import { useState } from "react";
import { ListTree, Flame } from "lucide-react";
import { Panel } from "@/components/ui/primitives";
import { ChapterAccordion } from "./ChapterAccordion";
import { NotionRow } from "./NotionRow";
import { buildPlan, byPriority, sectionBlocks, typesMeta, type UiType, type ProgramChapter } from "@/lib/ux/program";
import { cn } from "@/lib/ux/cn";

type Mode = "section" | "priority";

/**
 * Explorateur des notions, RUN v2. « Par section » = le PLAN DE COURS DU PROF en accordéon
 * (chapitres repliés → notions → occurrences). « Par priorité » = les notions les plus tombées
 * d'abord (liste plate, dépliable jusqu'aux occurrences). Repli honnête « par category » si le
 * plan n'a pas pu être dérivé pour ce cours.
 */
export function ProgramExplorer({
  types,
  chapters,
  planOk,
}: {
  types: UiType[];
  chapters: ProgramChapter[];
  planOk: boolean;
}) {
  const [mode, setMode] = useState<Mode>("section");
  const meta = typesMeta(types);
  const plan = buildPlan(types, chapters);
  const flat = byPriority(types);
  const hasPlan = planOk && chapters.length > 0;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Organiser les notions"
          className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-1/60 p-1"
        >
          <ToggleBtn active={mode === "section"} onClick={() => setMode("section")} Icon={ListTree}>
            Par section
          </ToggleBtn>
          <ToggleBtn active={mode === "priority"} onClick={() => setMode("priority")} Icon={Flame}>
            Par priorité
          </ToggleBtn>
        </div>
        <p className="text-[0.76rem] text-ink-4">
          {mode === "section" && hasPlan ? (
            <>
              <span className="font-data tabular text-ink-3">{plan.filter((c) => c.id != null).length}</span> chapitres
              <span className="mx-1 text-ink-4/60">·</span>
              <span className="font-data tabular text-ink-3">{meta.total}</span> notions
            </>
          ) : (
            <>
              <span className="font-data tabular text-ink-3">{meta.total}</span> notion{meta.total > 1 ? "s" : ""}
              {mode === "priority" ? " · les plus tombées d’abord" : " · ordre indicatif"}
            </>
          )}
        </p>
      </div>

      {mode === "section" ? (
        hasPlan ? (
          <div className="space-y-2.5">
            {plan.map((c) => (
              <ChapterAccordion key={c.id ?? "orphan"} c={c} />
            ))}
          </div>
        ) : (
          // Repli honnête : le plan de cours n'a pas pu être dérivé → regroupement par thème (category).
          <FallbackSections types={types} />
        )
      ) : (
        <Panel className="p-1.5 sm:p-2">
          {flat.map((t, i) => (
            <div key={t.key} className={cn(i > 0 && "border-t border-line")}>
              <NotionRow t={t} />
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}

/** Repli quand aucun plan de cours n'est dérivable : blocs par thème (category), sans rien inventer. */
function FallbackSections({ types }: { types: UiType[] }) {
  const blocks = sectionBlocks(types);
  return (
    <div className="space-y-2.5">
      <p className="text-[0.76rem] text-ink-4">
        Le plan de cours du prof n’a pas pu être dérivé pour ce cours — les notions sont regroupées par
        thème, dans l’ordre indicatif du cours.
      </p>
      {blocks.map((b, i) => (
        <Panel key={b.section ?? `__none-${i}`} className="overflow-hidden p-0">
          {b.section && (
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-line bg-surface-2/30 px-4 py-3">
              <h3 className="text-[0.95rem] font-semibold text-ink-1">{b.section}</h3>
              {b.approx && <span className="text-[0.7rem] text-ink-4">ordre approximatif</span>}
            </div>
          )}
          <div className="p-1.5 sm:p-2">
            {b.types.map((t, j) => (
              <div key={t.key} className={cn(j > 0 && "border-t border-line")}>
                <NotionRow t={t} />
              </div>
            ))}
          </div>
        </Panel>
      ))}
    </div>
  );
}

function ToggleBtn({
  active,
  onClick,
  Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-10 items-center gap-2 rounded-md px-3 text-[0.82rem] font-medium transition-colors",
        active ? "bg-surface-2 text-ink-1 ring-1 ring-line-strong" : "text-ink-3 hover:text-ink-1"
      )}
    >
      <Icon className="size-4" strokeWidth={2} />
      {children}
    </button>
  );
}
