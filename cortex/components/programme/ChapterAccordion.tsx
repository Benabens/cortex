"use client";

import { useEffect, useRef, useState } from "react";
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
  const rootRef = useRef<HTMLDivElement>(null);
  // Ouvert par lien profond (?chapitre=) : amené à l'écran.
  useEffect(() => {
    if (defaultOpen) rootRef.current?.scrollIntoView({ block: "start" });
  }, [defaultOpen]);

  return (
    <div ref={rootRef} className={cn("d2-card scroll-mt-24 overflow-hidden p-0 transition-colors", open && "border-accent/35")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(
          "flex w-full flex-wrap items-center gap-3 px-4 py-5 text-left sm:px-5 transition-colors hover:bg-surface-2/30",
          "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px]",
          open && "border-b border-line bg-accent/8"
        )}
      >
        <ChevronRight
          className={cn("size-4 shrink-0 text-ink-3 transition-transform duration-200", open && "rotate-90")}
          strokeWidth={2.25}
          aria-hidden="true"
        />
        {c.lectureNo != null && (
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-accent/20 bg-accent/10 font-data text-xs font-medium tabular text-accent-hi">
            L{c.lectureNo}
          </span>
        )}
        <span className="min-w-[8rem] flex-1">
          <span className="block text-base font-semibold text-ink-1">{c.title}</span>
        </span>
        {/* Tête légère : nb notions / nb tombées — jamais de débordement (complet au dépli). */}
        <span className="ml-7 shrink-0 whitespace-nowrap text-xs text-ink-3 sm:ml-0">
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
        <div id={panelId} className="rise-in p-2 sm:p-3">
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
