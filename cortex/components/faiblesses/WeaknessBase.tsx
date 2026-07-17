"use client";

import { useState } from "react";
import { ArrowUpRight, Trash2, ImageIcon, Target } from "lucide-react";
import { SEVERITY, type Severity } from "@/lib/ux/labels";
import { Badge } from "@/components/ui/Badge";
import { SeverityMeter } from "@/components/viz/SeverityMeter";
import { SectionHeader } from "@/components/ui/primitives";
import { useCourse } from "@/lib/ux/api";
import { sevOf, sourceLabel, relatedChips, type Weakness } from "@/lib/ux/weaknesses";
import { formatDay } from "@/lib/ux/types";
import { cn } from "@/lib/ux/cn";

const FILTERS: { key: Severity | "ALL"; label: string }[] = [
  { key: "ALL", label: "Toutes" },
  { key: "GROS", label: "Sévères" },
  { key: "MOYEN", label: "Moyennes" },
  { key: "LÉGER", label: "Légères" },
];

/** Base RÉELLE des faiblesses suivies (GET /api/weaknesses) + suppression. */
export function WeaknessBase({
  weaknesses,
  onChanged,
}: {
  weaknesses: Weakness[];
  onChanged: () => void;
}) {
  const { courseId } = useCourse();
  const [filter, setFilter] = useState<Severity | "ALL">("ALL");
  const [deleting, setDeleting] = useState<number | null>(null);

  const rows =
    filter === "ALL" ? weaknesses : weaknesses.filter((w) => sevOf(w.severity) === filter);
  const count = (k: Severity | "ALL") =>
    k === "ALL" ? weaknesses.length : weaknesses.filter((w) => sevOf(w.severity) === k).length;

  const remove = async (w: Weakness) => {
    if (deleting) return;
    if (!window.confirm(`Retirer « ${w.topic} » du suivi ? Cette action est définitive.`)) return;
    setDeleting(w.id);
    try {
      await fetch(`/api/weaknesses?id=${w.id}&course=${encodeURIComponent(courseId)}`, {
        method: "DELETE",
      });
      onChanged();
    } finally {
      setDeleting(null);
    }
  };

  return (
    <section>
      <SectionHeader
        title="Base des faiblesses"
        hint="Regroupées par thème, dans l’ordre du programme — filtre par sévérité si besoin."
      />

      {weaknesses.length === 0 ? (
        <div className="panel flex flex-col items-center gap-3 rounded-xl px-6 py-14 text-center">
          <span className="grid size-11 place-items-center rounded-lg border border-line bg-surface-2/60 text-ink-3">
            <Target className="size-5" strokeWidth={2} />
          </span>
          <p className="text-[0.95rem] font-medium text-ink-1">Aucune faiblesse suivie</p>
          <p className="max-w-sm text-[0.85rem] leading-relaxed text-ink-3">
            Ajoute ta première lacune ci-dessus : colle une discussion ou dépose un exo raté,
            et Cortex la gardera à l’œil pour tes drills.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-[0.82rem] font-medium transition-colors",
                  filter === f.key
                    ? "border-[color-mix(in_oklch,var(--color-violet)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-violet)_14%,transparent)] text-ink-1"
                    : "border-line bg-surface-1/60 text-ink-2 hover:bg-surface-2 hover:text-ink-1"
                )}
              >
                {f.label}
                <span className="font-data text-[0.72rem] tabular text-ink-4">{count(f.key)}</span>
              </button>
            ))}
          </div>

          <div className="panel overflow-hidden rounded-xl p-1.5">
            {rows.length === 0 ? (
              <p className="px-4 py-8 text-center text-[0.85rem] text-ink-3">
                Aucune lacune {FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} — retire le filtre pour tout voir.
              </p>
            ) : (
              rows
                .slice()
                // ordre du programme, best-effort : regroupé par thème (les lacunes sans thème en
                // fin — seul le minage de discussion renseigne `theme`), récent d'abord dans un thème.
                .sort((a, b) => {
                  const ta = a.theme ?? "￿", tb = b.theme ?? "￿";
                  if (ta !== tb) return ta.localeCompare(tb);
                  return (b.loggedAt ?? "").localeCompare(a.loggedAt ?? "");
                })
                .map((w, i) => {
                  const sev = SEVERITY[sevOf(w.severity)];
                  const chips = relatedChips(w.related);
                  const day = formatDay(w.loggedAt);
                  return (
                    <div
                      key={w.id}
                      className={cn(
                        "group flex flex-col gap-3 rounded-lg px-3 py-3.5 transition-colors hover:bg-surface-2/50 md:flex-row md:items-center md:gap-4",
                        i > 0 && "border-t border-line"
                      )}
                    >
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <SeverityMeter level={sev.level} tone={sev.tone} className="mt-1 shrink-0" />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="text-[0.95rem] font-medium text-ink-1">{w.topic}</h4>
                            <Badge tone={w.analyzed ? "success" : "warning"} size="xs">
                              {w.analyzed ? "Analysée" : "À analyser"}
                            </Badge>
                          </div>
                          {w.description && (
                            <p className="mt-0.5 line-clamp-2 max-w-2xl text-[0.8rem] text-ink-3">
                              {w.description}
                            </p>
                          )}
                          <p className="mt-1 text-[0.74rem] text-ink-4">
                            {sourceLabel(w.source)}
                            {day ? ` · ${day}` : ""}
                            {w.timesSeen > 1 ? ` · vue ${w.timesSeen} fois` : ""}
                            {w.screenshotUrl && (
                              <>
                                {" · "}
                                <a
                                  href={w.screenshotUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-ink-3 underline-offset-2 hover:text-violet-hi hover:underline"
                                >
                                  <ImageIcon className="size-3" strokeWidth={2} />
                                  screenshot
                                </a>
                              </>
                            )}
                          </p>
                        </div>
                      </div>

                      {(chips.length > 0 || w.theme) && (
                        <div className="flex flex-wrap items-center gap-1.5 md:w-[200px] md:shrink-0">
                          {w.theme && (
                            <span className="rounded-full border border-line bg-surface-1/60 px-2 py-0.5 text-[0.7rem] text-ink-3">
                              {w.theme}
                            </span>
                          )}
                          {chips.map((c) => (
                            <span
                              key={c}
                              className="rounded-full border border-line bg-surface-1/60 px-2 py-0.5 text-[0.7rem] text-ink-3"
                            >
                              {c}
                            </span>
                          ))}
                        </div>
                      )}

                      <div className="flex shrink-0 items-center gap-2">
                        <a
                          href={`/entrainement?drill=${encodeURIComponent(w.topic)}`}
                          aria-label={`Driller : ${w.topic}`}
                          className="inline-flex h-10 items-center justify-center gap-1 rounded-md border border-line bg-surface-2/60 px-3 text-[0.8rem] font-medium text-ink-2 transition-colors hover:border-[color-mix(in_oklch,var(--color-violet)_38%,transparent)] hover:text-ink-1"
                        >
                          Drill
                          <ArrowUpRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                        </a>
                        <button
                          type="button"
                          onClick={() => remove(w)}
                          disabled={deleting === w.id}
                          aria-label={`Retirer du suivi : ${w.topic}`}
                          className="grid size-10 place-items-center rounded-md border border-transparent text-ink-4 transition-colors hover:border-[color-mix(in_oklch,var(--color-danger)_35%,transparent)] hover:text-danger-hi disabled:opacity-50"
                        >
                          <Trash2 className="size-4" strokeWidth={2} />
                        </button>
                      </div>
                    </div>
                  );
                })
            )}
          </div>
        </>
      )}
    </section>
  );
}
