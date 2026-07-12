"use client";

import { useState } from "react";
import { LayoutList, ArrowDownWideNarrow } from "lucide-react";
import { Panel } from "@/components/ui/primitives";
import { WeightBar } from "@/components/viz/WeightBar";
import { TypeRow } from "./TypeRow";
import { byPriority, flatten, type SectionAgg } from "@/lib/ux/program";
import { cn } from "@/lib/ux/cn";

type Mode = "section" | "priority";

/** Explorateur du syllabus réel : par section (catégorie) ou par priorité (points à gagner). */
export function ProgramExplorer({ sections }: { sections: SectionAgg[] }) {
  const [mode, setMode] = useState<Mode>("section");
  const flat = flatten(sections);
  const maxWeight = Math.max(...flat.map((t) => t.weightPct), 1);
  const prioritized = byPriority(flat);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Trier le programme"
          className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-1/60 p-1"
        >
          <ToggleBtn active={mode === "section"} onClick={() => setMode("section")} Icon={LayoutList}>
            Par section
          </ToggleBtn>
          <ToggleBtn active={mode === "priority"} onClick={() => setMode("priority")} Icon={ArrowDownWideNarrow}>
            Par priorité
          </ToggleBtn>
        </div>

        <Legend />
      </div>

      {mode === "section" ? (
        <div key="section" className="space-y-4">
          {sections.map((sec, si) => (
            <SectionGroup key={sec.n} sec={sec} maxWeight={maxWeight} indexBase={si * 2} />
          ))}
        </div>
      ) : (
        <Panel key="priority" className="p-2 sm:p-3">
          {prioritized.map((t, i) => (
            <div key={t.key} className={cn(i > 0 && "border-t border-line")}>
              <TypeRow t={t} maxWeight={maxWeight} index={i} />
            </div>
          ))}
        </Panel>
      )}
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

function Legend() {
  return (
    <div className="flex items-center gap-3 text-[0.72rem] text-ink-3">
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block h-2 w-3 rounded-full"
          style={{ background: "linear-gradient(90deg, var(--color-emerald), var(--color-cyan))" }}
        />
        maîtrisé
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block h-2 w-3 rounded-full"
          style={{ background: "color-mix(in oklch, var(--color-violet) 42%, var(--color-surface-3))" }}
        />
        à gagner
      </span>
      <span className="hidden text-ink-4 sm:inline">— longueur ∝ poids à l’examen</span>
    </div>
  );
}

function SectionGroup({
  sec,
  maxWeight,
  indexBase,
}: {
  sec: SectionAgg;
  maxWeight: number;
  indexBase: number;
}) {
  return (
    <Panel className="overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface-2/30 px-4 py-3.5">
        <div className="flex items-center gap-3">
          <span className="grid size-8 place-items-center rounded-lg border border-line bg-surface-2 font-data text-[0.85rem] font-semibold text-ink-2">
            {sec.n}
          </span>
          <div>
            <h3 className="text-[1rem] font-semibold text-ink-1">{sec.section}</h3>
            <p className="text-[0.76rem] text-ink-3">
              {sec.coveredCount}/{sec.types.length} types vus ·{" "}
              <span className="font-data text-ink-2">≈ {sec.sharePct} %</span> de l’examen
            </p>
          </div>
        </div>
        <div className="w-40 shrink-0">
          <div className="mb-1 flex items-center justify-between text-[0.72rem]">
            <span className="text-ink-3">Maîtrise</span>
            <span className="font-data font-semibold text-ink-2">{sec.masteryWeighted} %</span>
          </div>
          <WeightBar
            pct={sec.masteryWeighted}
            from="var(--color-emerald)"
            to="var(--color-cyan)"
            height={6}
          />
        </div>
      </div>

      <div className="p-2 sm:p-2.5">
        {sec.types.map((t, i) => (
          <div key={t.key} className={cn(i > 0 && "border-t border-line")}>
            <TypeRow t={t} maxWeight={maxWeight} index={indexBase + i} />
          </div>
        ))}
      </div>
    </Panel>
  );
}
