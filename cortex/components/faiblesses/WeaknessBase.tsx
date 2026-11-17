"use client";

import { useState } from "react";
import { ArrowUpRight, Trash2, ImageIcon, FileText, Target, ListTree, LayoutList } from "lucide-react";
import { SEVERITY, type Severity } from "@/lib/ux/labels";
import { Badge } from "@/components/ui/Badge";
import { SeverityMeter } from "@/components/viz/SeverityMeter";
import { SectionHeader } from "@/components/ui/primitives";
import { Segmented, type SegmentedOption } from "@/components/ui/Segmented";
import { useCourse } from "@/lib/ux/api";
import { sevOf, sourceLabelKey, relatedChips, type Weakness } from "@/lib/ux/weaknesses";
import { cn } from "@/lib/ux/cn";
import { useTranslations } from "use-intl/react";
import { useFmt } from "@/lib/i18n/use-fmt";

const FILTERS: { key: Severity | "ALL"; labelKey: "filterAll" | "filterHigh" | "filterMedium" | "filterLow" }[] = [
  { key: "ALL", labelKey: "filterAll" },
  { key: "GROS", labelKey: "filterHigh" },
  { key: "MOYEN", labelKey: "filterMedium" },
  // i18n-allow: code de sévérité stable du back, jamais affiché
  { key: "LÉGER", labelKey: "filterLow" },
];

const NO_THEME = "￿"; // clé de tri pour « sans chapitre » (en fin)

/** Base RÉELLE des faiblesses suivies (GET /api/weaknesses) + suppression. */
export function WeaknessBase({
  weaknesses,
  onChanged,
  language,
}: {
  weaknesses: Weakness[];
  onChanged: () => void;
  language?: string;
}) {
  const t = useTranslations("weaknessBase");
  const groupings: SegmentedOption<"list" | "chapter">[] = [
    { value: "list", label: t("list"), Icon: LayoutList },
    { value: "chapter", label: t("byChapter"), Icon: ListTree },
  ];
  const { courseId } = useCourse();
  const [filter, setFilter] = useState<Severity | "ALL">("ALL");
  const [grouped, setGrouped] = useState(false); // P-C : grouper par chapitre (thème du plan)
  const [deleting, setDeleting] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const rows =
    filter === "ALL" ? weaknesses : weaknesses.filter((w) => sevOf(w.severity) === filter);
  const count = (k: Severity | "ALL") =>
    k === "ALL" ? weaknesses.length : weaknesses.filter((w) => sevOf(w.severity) === k).length;

  const remove = async (w: Weakness) => {
    if (deleting) return;
    if (!window.confirm(t("removeConfirm", { topic: w.topic }))) return;
    setDeleting(w.id);
    setDeleteError(null);
    try {
      const response = await fetch(`/api/weaknesses?id=${w.id}&course=${encodeURIComponent(courseId)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? t("removeFailed"));
      }
      onChanged();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t("removeFailed"));
    } finally {
      setDeleting(null);
    }
  };

  // tri intra-liste : plus sévère d'abord, puis récent.
  const bySeverity = (a: Weakness, b: Weakness) =>
    b.severity - a.severity || (b.loggedAt ?? "").localeCompare(a.loggedAt ?? "");

  // groupes par chapitre (thème) : blocs triés alpha, « Autres » (sans thème) en fin.
  const groups = (() => {
    const map = new Map<string, Weakness[]>();
    for (const w of rows) {
      const k = w.theme?.trim() || NO_THEME;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(w);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, ws]) => ({ theme: k === NO_THEME ? null : k, rows: ws.slice().sort(bySeverity) }));
  })();

  return (
    <section>
      <SectionHeader title={t("title")} />
      {deleteError && <p role="alert" className="mb-3 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger-hi">{deleteError}</p>}

      {weaknesses.length === 0 ? (
        <div className="d2-card flex flex-col items-center gap-3 px-6 py-16 text-center">
          <span className="grid size-12 place-items-center rounded-2xl border border-accent/25 bg-accent/10 text-accent-hi">
            <Target className="size-5" strokeWidth={2} />
          </span>
          <p className="text-[0.95rem] font-medium text-ink-1">{t("emptyTitle")}</p>
          <p className="max-w-sm text-[0.85rem] leading-relaxed text-ink-3">
            {t("emptyHint")}
          </p>
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <Segmented
              variant="pills"
              label={t("filterLabel")}
              options={FILTERS.map((f) => ({ value: f.key, label: t(f.labelKey), count: count(f.key) }))}
              value={filter}
              onChange={setFilter}
            />

            {/* P-C — grouper par chapitre du plan (thème), en plus du filtre sévérité */}
            <Segmented
              size="sm"
              label={t("organize")}
              options={groupings}
              value={grouped ? "chapter" : "list"}
              onChange={(v) => setGrouped(v === "chapter")}
            />
          </div>

          {rows.length === 0 ? (
            <div className="d2-card rounded-xl p-1.5">
              <p className="px-4 py-8 text-center text-[0.85rem] text-ink-3">
                {t("filteredEmpty", { filter: t(FILTERS.find((f) => f.key === filter)?.labelKey ?? "filterAll").toLowerCase() })}
              </p>
            </div>
          ) : grouped ? (
            <div className="space-y-2.5">
              {groups.map((g, gi) => (
                <div key={g.theme ?? `__none-${gi}`} className="d2-card overflow-hidden rounded-xl p-0">
                  <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-2/30 px-4 py-2.5">
                    <h3 className="text-[0.88rem] font-semibold text-ink-1" lang={g.theme ? language : undefined}>{g.theme ?? t("noChapter")}</h3>
                    <span className="font-data text-[0.72rem] tabular text-ink-4">{g.rows.length}</span>
                  </div>
                  <div className="p-1.5">
                    {g.rows.map((w, i) => (
                      <WeaknessRow key={w.id} w={w} i={i} level="h4" deleting={deleting} onRemove={remove} language={language} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="d2-card overflow-hidden rounded-xl p-1.5">
              {rows.slice().sort(bySeverity).map((w, i) => (
                <WeaknessRow key={w.id} w={w} i={i} level="h3" deleting={deleting} onRemove={remove} language={language} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Une ligne « faiblesse ». Le CTA « S'entraîner » pré-remplit /entrainement avec le concept (× + éditable). */
function WeaknessRow({
  w,
  i,
  level: Title,
  deleting,
  onRemove,
  language,
}: {
  w: Weakness;
  i: number;
  /** h3 dans la liste, h4 sous un chapitre (h3) : l'ordre des titres reste continu. */
  level: "h3" | "h4";
  deleting: number | null;
  onRemove: (w: Weakness) => void;
  language?: string;
}) {
  const t = useTranslations("weaknessBase");
  const f = useFmt();
  const sev = SEVERITY[sevOf(w.severity)];
  const chips = relatedChips(w.related);
  const day = w.loggedAt ? f.date(w.loggedAt, "short") : null;
  const sourceKey = sourceLabelKey(w.source);
  return (
    <div
      className={cn(
        "group flex flex-col gap-3 rounded-xl px-4 py-5 transition-colors hover:bg-surface-2/50 lg:flex-row lg:items-start lg:gap-4",
        i > 0 && "border-t border-line"
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <SeverityMeter level={sev.level} tone={sev.tone} className="mt-1 shrink-0" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Title className="text-[0.95rem] font-medium text-ink-1" lang={language}>{w.topic}</Title>
            {/* Pastille « Analysée » retirée (série 3) : seule l'exception reste signalée. */}
            {!w.analyzed && (
              <Badge tone="warning" size="xs">
                {t("toAnalyze")}
              </Badge>
            )}
          </div>
          {w.description && (
            <p className="mt-0.5 max-w-2xl text-[0.8rem] text-ink-3" lang={language}>{w.description}</p>
          )}
          <p className="mt-1 text-[0.74rem] text-ink-3">
            {sourceKey ? t(sourceKey) : w.source}
            {day ? ` · ${day}` : ""}
            {w.timesSeen > 1 ? ` · ${t("seen", { count: w.timesSeen })}` : ""}
            {w.screenshotUrl && (
              <>
                {" · "}
                <a
                  href={w.screenshotUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-ink-3 underline-offset-2 hover:text-accent-hi hover:underline"
                >
                  {/\.pdf$/i.test(w.screenshotUrl) ? (
                    <FileText className="size-3" strokeWidth={2} />
                  ) : (
                    <ImageIcon className="size-3" strokeWidth={2} />
                  )}
                  {/\.pdf$/i.test(w.screenshotUrl) ? t("sourcePdf") : t("image")}
                </a>
              </>
            )}
          </p>
        </div>
      </div>

      {(chips.length > 0 || w.theme) && (
        <div className="flex flex-wrap items-center gap-1.5 lg:max-w-[140px] lg:shrink-0">
          {w.theme && (
            <span className="rounded-full border border-line bg-surface-1/60 px-2 py-0.5 text-[0.7rem] text-ink-3" lang={language}>{w.theme}</span>
          )}
          {chips.map((c) => (
            <span key={c} className="rounded-full border border-line bg-surface-1/60 px-2 py-0.5 text-[0.7rem] text-ink-3" lang={language}>{c}</span>
          ))}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-2">
        <a
          href={`/entrainement?prefill=${encodeURIComponent(w.topic)}`}
          aria-label={t("trainOn", { topic: w.topic })}
          className="inline-flex min-h-11 items-center justify-center gap-1 rounded-full border border-line bg-surface-2/60 px-3 text-[0.8rem] font-medium text-ink-2 transition-colors hover:border-[color-mix(in_oklch,var(--color-accent)_38%,transparent)] hover:text-ink-1"
        >
          {t("train")}
          <ArrowUpRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </a>
        <button
          type="button"
          onClick={() => onRemove(w)}
          disabled={deleting !== null}
          aria-label={t("remove", { topic: w.topic })}
          className="grid size-11 place-items-center rounded-full border border-transparent text-ink-4 transition-colors hover:border-[color-mix(in_oklch,var(--color-danger)_35%,transparent)] hover:text-danger-hi disabled:opacity-50"
        >
          <Trash2 className="size-4" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
