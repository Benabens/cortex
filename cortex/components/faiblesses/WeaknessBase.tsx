"use client";

import { useState } from "react";
import { ArrowUpRight, Trash2, ImageIcon, Target, ListTree, LayoutList } from "lucide-react";
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

const NO_THEME = "￿"; // clé de tri pour « sans chapitre » (en fin)

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
  const [grouped, setGrouped] = useState(false); // P-C : grouper par chapitre (thème du plan)
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
      <SectionHeader
        title="Base des faiblesses"
        hint="Filtre par sévérité, ou groupe par chapitre du cours — chaque lacune se travaille en un clic."
      />

      {weaknesses.length === 0 ? (
        <div className="panel flex flex-col items-center gap-3 rounded-xl px-6 py-14 text-center">
          <span className="grid size-11 place-items-center rounded-lg border border-line bg-surface-2/60 text-ink-3">
            <Target className="size-5" strokeWidth={2} />
          </span>
          <p className="text-[0.95rem] font-medium text-ink-1">Aucune faiblesse suivie</p>
          <p className="max-w-sm text-[0.85rem] leading-relaxed text-ink-3">
            Ajoute ta première lacune ci-dessus : colle une discussion ou dépose un exo raté,
            et Cortex la gardera à l’œil pour tes séances d’entraînement.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
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

            {/* P-C — grouper par chapitre du plan (thème), en plus du filtre sévérité */}
            <div role="group" aria-label="Organiser la base" className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-1/60 p-1">
              <GroupBtn active={!grouped} onClick={() => setGrouped(false)} Icon={LayoutList}>Liste</GroupBtn>
              <GroupBtn active={grouped} onClick={() => setGrouped(true)} Icon={ListTree}>Par chapitre</GroupBtn>
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="panel rounded-xl p-1.5">
              <p className="px-4 py-8 text-center text-[0.85rem] text-ink-3">
                Aucune lacune {FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} — retire le filtre pour tout voir.
              </p>
            </div>
          ) : grouped ? (
            <div className="space-y-2.5">
              {groups.map((g, gi) => (
                <div key={g.theme ?? `__none-${gi}`} className="panel overflow-hidden rounded-xl p-0">
                  <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-2/30 px-4 py-2.5">
                    <h3 className="text-[0.88rem] font-semibold text-ink-1">{g.theme ?? "Sans chapitre"}</h3>
                    <span className="font-data text-[0.72rem] tabular text-ink-4">{g.rows.length}</span>
                  </div>
                  <div className="p-1.5">
                    {g.rows.map((w, i) => (
                      <WeaknessRow key={w.id} w={w} i={i} deleting={deleting} onRemove={remove} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="panel overflow-hidden rounded-xl p-1.5">
              {rows.slice().sort(bySeverity).map((w, i) => (
                <WeaknessRow key={w.id} w={w} i={i} deleting={deleting} onRemove={remove} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function GroupBtn({ active, onClick, Icon, children }: { active: boolean; onClick: () => void; Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[0.78rem] font-medium transition-colors",
        active ? "bg-surface-2 text-ink-1 ring-1 ring-line-strong" : "text-ink-3 hover:text-ink-1"
      )}
    >
      <Icon className="size-3.5" strokeWidth={2} />
      {children}
    </button>
  );
}

/** Une ligne « faiblesse ». Le CTA « S'entraîner » pré-remplit /entrainement avec le concept (× + éditable). */
function WeaknessRow({
  w,
  i,
  deleting,
  onRemove,
}: {
  w: Weakness;
  i: number;
  deleting: number | null;
  onRemove: (w: Weakness) => void;
}) {
  const sev = SEVERITY[sevOf(w.severity)];
  const chips = relatedChips(w.related);
  const day = formatDay(w.loggedAt);
  return (
    <div
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
            <p className="mt-0.5 line-clamp-2 max-w-2xl text-[0.8rem] text-ink-3">{w.description}</p>
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
                  image
                </a>
              </>
            )}
          </p>
        </div>
      </div>

      {(chips.length > 0 || w.theme) && (
        <div className="flex flex-wrap items-center gap-1.5 md:w-[200px] md:shrink-0">
          {w.theme && (
            <span className="rounded-full border border-line bg-surface-1/60 px-2 py-0.5 text-[0.7rem] text-ink-3">{w.theme}</span>
          )}
          {chips.map((c) => (
            <span key={c} className="rounded-full border border-line bg-surface-1/60 px-2 py-0.5 text-[0.7rem] text-ink-3">{c}</span>
          ))}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-2">
        <a
          href={`/entrainement?prefill=${encodeURIComponent(w.topic)}`}
          aria-label={`S'entraîner sur : ${w.topic}`}
          className="inline-flex h-10 items-center justify-center gap-1 rounded-md border border-line bg-surface-2/60 px-3 text-[0.8rem] font-medium text-ink-2 transition-colors hover:border-[color-mix(in_oklch,var(--color-violet)_38%,transparent)] hover:text-ink-1"
        >
          S’entraîner
          <ArrowUpRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </a>
        <button
          type="button"
          onClick={() => onRemove(w)}
          disabled={deleting === w.id}
          aria-label={`Retirer du suivi : ${w.topic}`}
          className="grid size-10 place-items-center rounded-md border border-transparent text-ink-4 transition-colors hover:border-[color-mix(in_oklch,var(--color-danger)_35%,transparent)] hover:text-danger-hi disabled:opacity-50"
        >
          <Trash2 className="size-4" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
