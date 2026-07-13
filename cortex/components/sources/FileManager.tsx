"use client";

import { useState } from "react";
import { FileText, FileCode2, Layers, BadgeCheck, UploadCloud } from "lucide-react";
import { Panel } from "@/components/ui/primitives";
import { corpusLabel, extOf, type SourcesResp } from "@/lib/ux/sources";
import { cn } from "@/lib/ux/cn";

const extTone: Record<string, string> = {
  PDF: "var(--color-danger)",
  HTML: "var(--color-cyan)",
  HTM: "var(--color-cyan)",
  TXT: "var(--color-ink-3)",
  MD: "var(--color-violet)",
};

/**
 * Corpus RÉEL du cours : agrégats par type (chips) + table des annales de référence.
 * Pas de toggle « actif » : le back n'expose pas cette commande — badges lecture seule.
 */
export function FileManager({ data }: { data: SourcesResp }) {
  const [kind, setKind] = useState<string | null>(null);

  const kinds = [...new Set(data.exams.map((e) => e.kind))];
  const files = kind ? data.exams.filter((e) => e.kind === kind) : data.exams;
  const totalItems = data.corpus.reduce((a, c) => a + c.items, 0);

  return (
    <Panel className="overflow-hidden p-0">
      {/* corpus summary (agrégats réels) */}
      <div className="border-b border-line px-4 py-3.5">
        <div className="flex items-center gap-2 text-[0.76rem] text-ink-3">
          <Layers className="size-3.5" strokeWidth={2} />
          Corpus ingéré ·{" "}
          <span className="font-data font-semibold text-ink-2">{totalItems}</span> extraits
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {data.corpus.map((c) => (
            <span
              key={c.type}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-surface-1/60 px-2.5 text-[0.8rem] text-ink-2"
            >
              {corpusLabel(c.type)}
              <span className="font-data text-[0.72rem] tabular text-ink-4">
                {c.sources} src · {c.items}
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* filtres par kind d'annale */}
      {kinds.length > 1 && (
        <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3">
          <KindChip label="Toutes" count={data.exams.length} active={kind === null} onClick={() => setKind(null)} />
          {kinds.map((k) => (
            <KindChip
              key={k}
              label={corpusLabel(k)}
              count={data.exams.filter((e) => e.kind === k).length}
              active={kind === k}
              onClick={() => setKind(kind === k ? null : k)}
            />
          ))}
        </div>
      )}

      {/* table header (desktop) */}
      <div className="hidden items-center gap-3 border-b border-line px-4 py-2 text-[0.68rem] font-medium uppercase tracking-wider text-ink-4 md:flex">
        <span className="w-8" />
        <span className="flex-1">Annale</span>
        <span className="w-14">Type</span>
        <span className="w-14 text-right">Extraits</span>
        <span className="w-48 text-right">Statut</span>
      </div>

      {/* files (annales réelles) */}
      <div className="p-1.5">
        {files.map((f, i) => {
          const ext = extOf(f.path);
          const Icon = ext === "HTML" || ext === "HTM" ? FileCode2 : FileText;
          const tone = extTone[ext] ?? "var(--color-ink-3)";
          return (
            <div
              key={f.path}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-2/40",
                i > 0 && "border-t border-line"
              )}
            >
              <span
                className="grid size-8 shrink-0 place-items-center rounded-md border border-line bg-surface-2/60"
                style={{ color: tone }}
              >
                <Icon className="size-4" strokeWidth={2} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[0.88rem] text-ink-1">
                  {f.title}
                  {f.year ? <span className="ml-1.5 text-ink-3">· {f.year}</span> : null}
                </div>
                <div className="text-[0.72rem] text-ink-4 md:hidden">
                  {ext} · {f.items} extraits
                </div>
              </div>
              <span className="hidden w-14 md:block">
                <span
                  className="inline-flex rounded-md px-1.5 py-0.5 font-mono text-[0.68rem] font-medium"
                  style={{ color: tone, background: `color-mix(in oklch, ${tone} 12%, transparent)` }}
                >
                  {ext}
                </span>
              </span>
              <span className="hidden w-14 text-right font-data text-[0.82rem] tabular text-ink-2 md:block">
                {f.items}
              </span>
              <span className="flex w-48 flex-wrap items-center justify-end gap-1.5">
                {f.isReference && (
                  <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.68rem] font-medium text-violet-hi" style={{ background: "color-mix(in oklch, var(--color-violet) 14%, transparent)" }}>
                    <BadgeCheck className="size-3" strokeWidth={2.25} />
                    Référence
                  </span>
                )}
                {f.uploaded && (
                  <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.68rem] font-medium text-cyan-hi" style={{ background: "color-mix(in oklch, var(--color-cyan) 12%, transparent)" }}>
                    <UploadCloud className="size-3" strokeWidth={2.25} />
                    Uploadé
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-[0.78rem] text-ink-3">
        <span className="font-data font-semibold text-ink-1">{data.exams.filter((e) => e.isReference).length}</span>
        annales de référence — le format des examens blancs se cale dessus
      </div>
    </Panel>
  );
}

function KindChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-md border px-2.5 text-[0.8rem] font-medium transition-colors",
        active
          ? "border-[color-mix(in_oklch,var(--color-violet)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-violet)_14%,transparent)] text-ink-1"
          : "border-line bg-surface-1/60 text-ink-2 hover:bg-surface-2 hover:text-ink-1"
      )}
    >
      {label}
      <span className="font-data text-[0.72rem] tabular text-ink-4">{count}</span>
    </button>
  );
}
