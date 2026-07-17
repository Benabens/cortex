"use client";

import { useEffect, useState } from "react";
import { FileText, FileCode2, Layers, Check, Trash2, UploadCloud } from "lucide-react";
import { Panel } from "@/components/ui/primitives";
import { apiPost, useCourse } from "@/lib/ux/api";
import { corpusLabel, extOf, type SourcesResp, type SourceExam } from "@/lib/ux/sources";
import { cn } from "@/lib/ux/cn";

const extTone: Record<string, string> = {
  PDF: "var(--color-danger)",
  HTML: "var(--color-cyan)",
  HTM: "var(--color-cyan)",
  TXT: "var(--color-ink-3)",
  MD: "var(--color-violet)",
};

/**
 * Corpus RÉEL du cours + choix des ANNALES DE RÉFÉRENCE (cases à cocher, câblées sur
 * `toggleReference`) : POST /api/sources {path, reference} bascule ; DELETE /api/sources?path=
 * supprime un fichier uploadé. Le format des blancs se cale sur les annales cochées.
 */
export function FileManager({ data, onChanged }: { data: SourcesResp; onChanged: () => void }) {
  const { courseId } = useCourse();
  const [kind, setKind] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({}); // path → isReference optimiste
  const [busy, setBusy] = useState<Set<string>>(new Set());

  // données fraîches (après refetch) → on efface les surcharges optimistes.
  useEffect(() => setPending({}), [data]);

  const isRef = (f: SourceExam) => pending[f.path] ?? f.isReference;
  const setBusyFor = (path: string, on: boolean) =>
    setBusy((s) => { const n = new Set(s); on ? n.add(path) : n.delete(path); return n; });

  const toggleRef = async (f: SourceExam) => {
    const next = !isRef(f);
    setPending((p) => ({ ...p, [f.path]: next }));
    setBusyFor(f.path, true);
    try {
      await apiPost("/api/sources", courseId, { path: f.path, reference: next });
      onChanged();
    } catch {
      setPending((p) => ({ ...p, [f.path]: !next })); // rollback
    } finally {
      setBusyFor(f.path, false);
    }
  };

  const remove = async (f: SourceExam) => {
    if (!window.confirm(`Retirer « ${f.title} » du corpus ? (fichier uploadé)`)) return;
    setBusyFor(f.path, true);
    try {
      await fetch(`/api/sources?path=${encodeURIComponent(f.path)}&course=${encodeURIComponent(courseId)}`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusyFor(f.path, false);
    }
  };

  const kinds = [...new Set(data.exams.map((e) => e.kind))];
  const files = kind ? data.exams.filter((e) => e.kind === kind) : data.exams;
  const totalItems = data.corpus.reduce((a, c) => a + c.items, 0);
  const refCount = data.exams.filter((e) => isRef(e)).length;

  return (
    <Panel className="overflow-hidden p-0">
      {/* corpus summary (agrégats réels) */}
      <div className="border-b border-line px-4 py-3.5">
        <div className="flex items-center gap-2 text-[0.76rem] text-ink-3">
          <Layers className="size-3.5" strokeWidth={2} />
          Corpus ingéré · <span className="font-data font-semibold text-ink-2">{totalItems}</span> extraits
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {data.corpus.map((c) => (
            <span
              key={c.type}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-surface-1/60 px-2.5 text-[0.8rem] text-ink-2"
            >
              {corpusLabel(c.type)}
              <span className="font-data text-[0.72rem] tabular text-ink-4">{c.sources} src · {c.items}</span>
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
      <div className="hidden items-center gap-3 border-b border-line px-4 py-2 text-[0.68rem] font-medium text-ink-4 md:flex">
        <span className="w-8" />
        <span className="flex-1">Annale</span>
        <span className="w-14 text-right">Extraits</span>
        <span className="w-44 text-right">Référence</span>
      </div>

      {/* files (annales réelles) + cases à cocher « référence » */}
      <div className="p-1.5">
        {files.map((f, i) => {
          const ext = extOf(f.path);
          const Icon = ext === "HTML" || ext === "HTM" ? FileCode2 : FileText;
          const tone = extTone[ext] ?? "var(--color-ink-3)";
          const checked = isRef(f);
          const isBusy = busy.has(f.path);
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
                <div className="flex items-center gap-1.5 text-[0.72rem] text-ink-4">
                  <span className="font-mono">{ext}</span>
                  <span>· {f.items} extraits</span>
                  {f.uploaded && (
                    <span className="inline-flex items-center gap-1 text-cyan-hi">
                      <UploadCloud className="size-3" strokeWidth={2.25} /> uploadé
                    </span>
                  )}
                </div>
              </div>

              {/* extraits (desktop) */}
              <span className="hidden w-14 text-right font-data text-[0.82rem] tabular text-ink-3 md:block">
                {f.items}
              </span>

              {/* case à cocher « référence » + suppression si uploadé */}
              <div className="flex w-44 shrink-0 items-center justify-end gap-1.5">
                <RefCheckbox checked={checked} busy={isBusy} onToggle={() => toggleRef(f)} label={f.title} />
                {f.uploaded && (
                  <button
                    type="button"
                    onClick={() => remove(f)}
                    disabled={isBusy}
                    aria-label={`Retirer ${f.title}`}
                    className="grid size-8 shrink-0 place-items-center rounded-md text-ink-4 transition-colors hover:bg-surface-2 hover:text-danger-hi focus-visible:outline-2 focus-visible:outline-violet focus-visible:outline-offset-2 disabled:opacity-40"
                  >
                    <Trash2 className="size-4" strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-[0.78rem] text-ink-3">
        <span className="font-data font-semibold text-ink-1">{refCount}</span>
        annale{refCount > 1 ? "s" : ""} de référence cochée{refCount > 1 ? "s" : ""} — le format des blancs se cale dessus
      </div>
    </Panel>
  );
}

/** Case à cocher accessible « annale de référence ». */
function RefCheckbox({
  checked,
  busy,
  onToggle,
  label,
}: {
  checked: boolean;
  busy: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={`Utiliser « ${label} » comme annale de référence`}
      disabled={busy}
      onClick={onToggle}
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-[0.78rem] font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-violet focus-visible:outline-offset-2 disabled:opacity-50",
        checked
          ? "border-[color-mix(in_oklch,var(--color-violet)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-violet)_16%,transparent)] text-violet-hi"
          : "border-line bg-surface-2/40 text-ink-3 hover:text-ink-1"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-4 place-items-center rounded-[5px] border transition-colors",
          checked ? "border-transparent bg-violet-deep text-white" : "border-line-strong bg-surface-1"
        )}
      >
        {checked && <Check className="size-3" strokeWidth={3} />}
      </span>
      Référence
    </button>
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
