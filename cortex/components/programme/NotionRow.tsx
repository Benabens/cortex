"use client";

import { useState } from "react";
import { ChevronRight, FileText, BookOpen } from "lucide-react";
import { cn } from "@/lib/ux/cn";
import { DeepLink } from "./DeepLink";
import type { UiType } from "@/lib/ux/program";

/**
 * Ligne « notion » de l'accordéon (niveau 2). Repliée : la notion + sa méthode + « tombé N fois ».
 * Dépliée : TOUTES ses occurrences réelles (chaque final + page → deep-link) + le passage de cours.
 * Complétude au niveau le plus profond → aucun débordement tant que c'est replié. Zéro point affiché.
 */
export function NotionRow({ t }: { t: UiType }) {
  const [open, setOpen] = useState(false);
  const hasDetail = t.occurrences.length > 0 || !!t.courseHref;
  const panelId = `notion-${t.key}`;

  return (
    <div>
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        aria-expanded={hasDetail ? open : undefined}
        aria-controls={hasDetail ? panelId : undefined}
        disabled={!hasDetail}
        className={cn(
          "group flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition-colors",
          hasDetail ? "hover:bg-surface-2/40" : "cursor-default",
          "focus-visible:outline-2 focus-visible:outline-violet focus-visible:outline-offset-[-2px]"
        )}
      >
        <ChevronRight
          className={cn(
            "mt-0.5 size-4 shrink-0 text-ink-4 transition-transform duration-200",
            open && "rotate-90",
            !hasDetail && "opacity-0"
          )}
          strokeWidth={2.25}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[0.9rem] font-medium text-ink-1">{t.title}</span>
          {t.desc && <span className="mt-0.5 block line-clamp-2 text-[0.78rem] leading-relaxed text-ink-3">{t.desc}</span>}
        </span>
        <span className="shrink-0 pt-0.5 text-[0.78rem] text-ink-3">
          {t.count > 0 ? (
            <span className="whitespace-nowrap" aria-label={`tombé ${t.count} fois aux finals`}>
              Tombé <span className="font-data font-semibold text-ink-1 tabular">{t.count}</span> fois
            </span>
          ) : (
            <span className="whitespace-nowrap text-ink-4">au programme</span>
          )}
        </span>
      </button>

      {hasDetail && open && (
        <div id={panelId} className="rise-in pb-3 pl-10 pr-3">
          {t.occurrences.length > 0 && (
            <div>
              <p className="mb-1.5 text-[0.72rem] font-medium uppercase tracking-wide text-ink-4">
                {t.occurrences.length > 1 ? `Toutes les occurrences (${t.occurrences.length})` : "Occurrence"}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {t.occurrences.map((o) =>
                  o.examHref ? (
                    <DeepLink key={o.key} href={o.examHref} Icon={FileText}>
                      {o.label}
                    </DeepLink>
                  ) : (
                    <span
                      key={o.key}
                      className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2/30 px-2 py-1 text-[0.74rem] text-ink-3"
                    >
                      <FileText className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                      {o.label}
                    </span>
                  )
                )}
              </div>
            </div>
          )}
          {t.courseHref && (
            <div className="mt-2.5">
              <DeepLink href={t.courseHref} Icon={BookOpen}>
                Passage de cours
              </DeepLink>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
