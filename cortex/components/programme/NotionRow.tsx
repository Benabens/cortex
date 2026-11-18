"use client";

import { useState } from "react";
import { ChevronRight, FileText, BookOpen } from "lucide-react";
import { cn } from "@/lib/ux/cn";
import { DeepLink } from "./DeepLink";
import type { UiType } from "@/lib/ux/program";
import { useTranslations } from "use-intl/react";

/**
 * Ligne « notion » de l'accordéon (niveau 2). Repliée : la notion + sa méthode + « tombé N fois ».
 * Dépliée : TOUTES ses occurrences réelles (chaque final + page → deep-link) + le passage de cours.
 * Complétude au niveau le plus profond → aucun débordement tant que c'est replié. Zéro point affiché.
 */
export function NotionRow({ t: notion, language }: { t: UiType; language?: string }) {
  const t = useTranslations("notionRow");
  const [open, setOpen] = useState(false);
  const hasDetail = notion.occurrences.length > 0 || !!notion.courseHref;
  const panelId = `notion-${notion.key}`;

  return (
    <div>
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        aria-expanded={hasDetail ? open : undefined}
        aria-controls={hasDetail ? panelId : undefined}
        disabled={!hasDetail}
        className={cn(
          "group flex w-full flex-wrap items-start gap-3 rounded-xl px-3 py-4 text-left transition-colors",
          hasDetail ? "hover:bg-surface-2/40" : "cursor-default",
          "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px]"
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
        <span className="min-w-[8rem] flex-1">
          <span className="block text-[0.9rem] font-medium text-ink-1" lang={language}>{notion.title}</span>
          {notion.desc && <span className="mt-1 block text-[0.8rem] leading-relaxed text-ink-3" lang={language}>{notion.desc}</span>}
        </span>
        <span className="ml-7 shrink-0 pt-0.5 text-[0.78rem] text-ink-3 sm:ml-0">
          {notion.count > 0 ? (
            <span className="whitespace-nowrap" aria-label={t("fallenLabel", { count: notion.count })}>
              {t.rich("fallen", { count: notion.count, num: (v) => <span className="font-data font-semibold text-ink-1 tabular">{v}</span> })}
            </span>
          ) : (
            <span className="whitespace-nowrap text-ink-4">{t("inSyllabus")}</span>
          )}
        </span>
      </button>

      {hasDetail && open && (
        <div id={panelId} className="rise-in mx-3 mb-3 rounded-xl border border-line bg-bg/40 p-4 sm:ml-10">
          {notion.occurrences.length > 0 && (
            <div>
              {/* Pas d'intitulé en capitales : les chips (final + page) se lisent seules,
                  le compte est déjà dans « Tombé N fois ». */}
              <div className="flex flex-wrap gap-1.5">
                {notion.occurrences.map((o) =>
                  o.examHref ? (
                    <DeepLink key={o.key} href={o.examHref} Icon={FileText}>
                      <span lang={language}>{o.label}</span>
                    </DeepLink>
                  ) : (
                    <span
                      key={o.key}
                      className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2/30 px-2 py-1 text-[0.74rem] text-ink-3"
                    >
                      <FileText className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                      <span lang={language}>{o.label}</span>
                    </span>
                  )
                )}
              </div>
            </div>
          )}
          {notion.courseHref && (
            <div className="mt-2.5">
              <DeepLink href={notion.courseHref} Icon={BookOpen}>
                {t("coursePassage")}
              </DeepLink>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
