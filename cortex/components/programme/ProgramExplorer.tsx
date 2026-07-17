"use client";

import { useState } from "react";
import { LayoutList, Flame } from "lucide-react";
import { Panel } from "@/components/ui/primitives";
import { TypeRow } from "./TypeRow";
import { byPriority, sectionBlocks, typesMeta, type UiType } from "@/lib/ux/program";
import { cn } from "@/lib/ux/cn";

type Mode = "section" | "priority";

/** Explorateur des notions réelles : par section (ordre du cours) ou par priorité (le plus tombé). */
export function ProgramExplorer({ types }: { types: UiType[] }) {
  const [mode, setMode] = useState<Mode>("section");
  const blocks = sectionBlocks(types);
  const flat = byPriority(types);
  const meta = typesMeta(types);
  // honnêteté : si certaines notions n'ont pas de position de cours, le tri « par section » est approximatif.
  const partialOrder = mode === "section" && meta.anyOrder && blocks.some((b) => !b.ordered);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Trier les notions"
          className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-1/60 p-1"
        >
          <ToggleBtn active={mode === "section"} onClick={() => setMode("section")} Icon={LayoutList}>
            Par section
          </ToggleBtn>
          <ToggleBtn active={mode === "priority"} onClick={() => setMode("priority")} Icon={Flame}>
            Par priorité
          </ToggleBtn>
        </div>
        <p className="text-[0.76rem] text-ink-4">
          <span className="font-data tabular text-ink-3">{meta.total}</span> notion{meta.total > 1 ? "s" : ""}
          {mode === "section" ? " · ordre du cours" : " · les plus tombées d’abord"}
        </p>
      </div>

      {mode === "section" ? (
        <div className="space-y-4">
          {partialOrder && (
            <p className="text-[0.76rem] text-ink-4">
              Ordre du cours approximatif — certaines notions ne sont pas encore rattachées à un passage précis.
            </p>
          )}
          {blocks.map((b, i) => (
            <Panel key={b.section ?? `__none-${i}`} className="overflow-hidden p-0">
              {b.section && (
                <div className="border-b border-line bg-surface-2/30 px-4 py-3">
                  <h3 className="text-[0.95rem] font-semibold text-ink-1">{b.section}</h3>
                </div>
              )}
              <div className="p-1.5 sm:p-2">
                {b.types.map((t, j) => (
                  <div key={t.key} className={cn(j > 0 && "border-t border-line")}>
                    <TypeRow t={t} />
                  </div>
                ))}
              </div>
            </Panel>
          ))}
        </div>
      ) : (
        <Panel className="p-1.5 sm:p-2">
          {flat.map((t, i) => (
            <div key={t.key} className={cn(i > 0 && "border-t border-line")}>
              <TypeRow t={t} />
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
