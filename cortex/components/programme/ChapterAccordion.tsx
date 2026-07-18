"use client";

import { useState } from "react";
import { ChevronRight, BookOpen } from "lucide-react";
import { cn } from "@/lib/ux/cn";
import { NotionRow } from "./NotionRow";
import { DeepLink } from "./DeepLink";
import type { PlanChapterUi } from "@/lib/ux/program";

/**
 * Chapitre du plan de cours (niveau 1 de l'accordéon). Replié par défaut : titre du prof + n° de
 * lecture + tête légère (nb notions / nb tombées). Déplié : ses notions (chacune dépliable →
 * occurrences). Un chapitre sans notion tombée reste listé (complétude du plan), tête « aucune ».
 */
export function ChapterAccordion({ c, defaultOpen = false }: { c: PlanChapterUi; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = `chapter-${c.id ?? "orphan"}`;
  const n = c.notions.length;

  return (
    <div className="panel overflow-hidden p-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(
          "flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-2/30",
          "focus-visible:outline-2 focus-visible:outline-violet focus-visible:outline-offset-[-2px]",
          open && "border-b border-line"
        )}
      >
        <ChevronRight
          className={cn("size-4 shrink-0 text-ink-3 transition-transform duration-200", open && "rotate-90")}
          strokeWidth={2.25}
          aria-hidden="true"
        />
        {c.lectureNo != null && (
          <span className="shrink-0 rounded-md border border-line bg-surface-2/60 px-1.5 py-0.5 font-data text-[0.72rem] font-medium tabular text-ink-3">
            L{c.lectureNo}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.95rem] font-semibold text-ink-1">{c.title}</span>
        </span>
        {/* Tête légère : nb notions / nb tombées — jamais de débordement (complet au dépli). */}
        <span className="shrink-0 whitespace-nowrap text-[0.76rem] text-ink-4">
          {n === 0 ? (
            "aucune notion"
          ) : c.fallenCount > 0 ? (
            <>
              <span className="font-data tabular text-ink-2">{n}</span> notion{n > 1 ? "s" : ""}
              <span className="mx-1 text-ink-4/60">·</span>
              <span className="font-data tabular text-ink-2">{c.fallenCount}</span> tombée{c.fallenCount > 1 ? "s" : ""}
            </>
          ) : (
            <>
              <span className="font-data tabular text-ink-2">{n}</span> notion{n > 1 ? "s" : ""} · aucune tombée
            </>
          )}
        </span>
      </button>

      {open && (
        <div id={panelId} className="rise-in p-1.5 sm:p-2">
          {n === 0 ? (
            <div className="flex flex-col items-start gap-2 px-3 py-4">
              <p className="text-[0.82rem] text-ink-3">
                Aucune notion de ce chapitre n’est encore tombée dans les annales indexées.
              </p>
              {c.sourceHref && (
                <DeepLink href={c.sourceHref} Icon={BookOpen}>
                  Ouvrir la lecture
                </DeepLink>
              )}
            </div>
          ) : (
            c.notions.map((t, i) => (
              <div key={t.key} className={cn(i > 0 && "border-t border-line")}>
                <NotionRow t={t} />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
