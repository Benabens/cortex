"use client";

import { useEffect, useMemo, useState } from "react";
import { FileText, FileCode2, Layers, Check, Trash2, UploadCloud, ArrowUpRight } from "lucide-react";
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

const ANNALE_TYPES = new Set(["final", "midterm"]);
// ordre d'affichage préféré des facettes non-annales
const FACET_ORDER = ["course_pdf", "lecture", "serie", "exercise", "cheatsheet", "review", "note", "code", "lab", "doc"];

/**
 * Corpus RÉEL du cours. Les FACETTES sont cliquables (RUN v2) : « Annales » (défaut, avec cases
 * « Référence ») + un chip par type de corpus (Cours / Séries / Exercices / Cheat sheets…) qui
 * FILTRE la liste et permet d'OUVRIR chaque item via le deep-link « voir ». Le format des blancs
 * se cale sur les annales cochées. Bascule « Référence » optimiste → aucun saut de ligne.
 */
export function FileManager({ data, onChanged }: { data: SourcesResp; onChanged: () => void }) {
  const { courseId } = useCourse();
  const [facet, setFacet] = useState<string | null>(null); // null = Annales (défaut)
  const [pending, setPending] = useState<Record<string, boolean>>({}); // path → isReference optimiste
  const [busy, setBusy] = useState<Set<string>>(new Set());

  // données fraîches (après un vrai refetch, ex. upload/suppression) → on efface les surcharges.
  useEffect(() => setPending({}), [data]);

  const isRef = (f: SourceExam) => pending[f.path] ?? f.isReference;
  const setBusyFor = (path: string, on: boolean) =>
    setBusy((s) => { const n = new Set(s); on ? n.add(path) : n.delete(path); return n; });

  const hrefByPath = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const s of data.sources ?? []) m.set(s.path, s.href);
    return m;
  }, [data.sources]);

  const toggleRef = async (f: SourceExam) => {
    const next = !isRef(f);
    setPending((p) => ({ ...p, [f.path]: next }));
    setBusyFor(f.path, true);
    try {
      // On NE refetch PAS : l'état optimiste fait foi côté UI, le POST persiste côté serveur.
      // → la liste ne se remonte plus, la ligne ne saute plus (fix jank).
      await apiPost("/api/sources", courseId, { path: f.path, reference: next });
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

  // Facettes : « Annales » + types de corpus non-annales présents (dans l'ordre préféré).
  const nonAnnaleTypes = (data.corpus ?? [])
    .filter((c) => !ANNALE_TYPES.has(c.type))
    .sort((a, b) => (FACET_ORDER.indexOf(a.type) + 1 || 99) - (FACET_ORDER.indexOf(b.type) + 1 || 99));
  const annaleCount = data.exams.length;
  const totalItems = data.corpus.reduce((a, c) => a + c.items, 0);
  const refCount = data.exams.filter((e) => isRef(e)).length;

  const browseRows = facet ? (data.sources ?? []).filter((s) => s.type === facet) : [];

  return (
    <Panel className="overflow-hidden p-0">
      {/* résumé + FACETTES cliquables */}
      <div className="border-b border-line px-4 py-3.5">
        <div className="flex items-center gap-2 text-[0.76rem] text-ink-3">
          <Layers className="size-3.5" strokeWidth={2} />
          Corpus ingéré · <span className="font-data font-semibold text-ink-2">{totalItems}</span> extraits
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <FacetChip label="Annales" count={annaleCount} active={facet === null} onClick={() => setFacet(null)} />
          {nonAnnaleTypes.map((c) => (
            <FacetChip
              key={c.type}
              label={corpusLabel(c.type)}
              count={c.sources}
              active={facet === c.type}
              onClick={() => setFacet(facet === c.type ? null : c.type)}
            />
          ))}
        </div>
      </div>

      {facet === null ? (
        <>
          {/* en-tête table annales (desktop) */}
          <div className="hidden items-center gap-3 border-b border-line px-4 py-2 text-[0.68rem] font-medium text-ink-4 md:flex">
            <span className="w-8" />
            <span className="flex-1">Annale</span>
            <span className="w-14 text-right">Extraits</span>
            <span className="w-52 text-right">Ouvrir · Référence</span>
          </div>

          <div className="p-1.5">
            {data.exams.map((f, i) => {
              const ext = extOf(f.path);
              const Icon = ext === "HTML" || ext === "HTM" ? FileCode2 : FileText;
              const tone = extTone[ext] ?? "var(--color-ink-3)";
              const isBusy = busy.has(f.path);
              const href = hrefByPath.get(f.path) ?? null;
              return (
                <div key={f.path} className={cn("flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-2/40", i > 0 && "border-t border-line")}>
                  <span className="grid size-8 shrink-0 place-items-center rounded-md border border-line bg-surface-2/60" style={{ color: tone }}>
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
                        <span className="inline-flex items-center gap-1 text-cyan-hi"><UploadCloud className="size-3" strokeWidth={2.25} /> uploadé</span>
                      )}
                    </div>
                  </div>

                  <span className="hidden w-14 text-right font-data text-[0.82rem] tabular text-ink-3 md:block">{f.items}</span>

                  {/* Ouvrir (voir) + Référence + emplacement RÉSERVÉ pour la poubelle → aucun décalage */}
                  <div className="flex w-52 shrink-0 items-center justify-end gap-1.5">
                    {href && <SeeLink href={href} label={f.title} />}
                    <RefCheckbox checked={isRef(f)} busy={isBusy} onToggle={() => toggleRef(f)} label={f.title} />
                    {f.uploaded ? (
                      <button
                        type="button"
                        onClick={() => remove(f)}
                        disabled={isBusy}
                        aria-label={`Retirer ${f.title}`}
                        className="grid size-8 shrink-0 place-items-center rounded-md text-ink-4 transition-colors hover:bg-surface-2 hover:text-danger-hi focus-visible:outline-2 focus-visible:outline-violet focus-visible:outline-offset-2 disabled:opacity-40"
                      >
                        <Trash2 className="size-4" strokeWidth={2} />
                      </button>
                    ) : (
                      <span className="size-8 shrink-0" aria-hidden="true" />
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
        </>
      ) : (
        // Vue « browse » d'un type de corpus : chaque item ouvrable via « voir ».
        <div className="p-1.5">
          {browseRows.length === 0 ? (
            <p className="px-4 py-8 text-center text-[0.85rem] text-ink-3">Aucun élément de ce type dans le corpus.</p>
          ) : (
            browseRows.map((s, i) => {
              const ext = extOf(s.path);
              const Icon = ext === "HTML" || ext === "HTM" ? FileCode2 : FileText;
              const tone = extTone[ext] ?? "var(--color-ink-3)";
              return (
                <div key={s.path} className={cn("flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-2/40", i > 0 && "border-t border-line")}>
                  <span className="grid size-8 shrink-0 place-items-center rounded-md border border-line bg-surface-2/60" style={{ color: tone }}>
                    <Icon className="size-4" strokeWidth={2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[0.88rem] text-ink-1">
                      {s.title}
                      {s.year ? <span className="ml-1.5 text-ink-3">· {s.year}</span> : null}
                    </div>
                    <div className="flex items-center gap-1.5 text-[0.72rem] text-ink-4">
                      <span className="font-mono">{ext}</span>
                      <span>· {s.items} extraits</span>
                    </div>
                  </div>
                  {s.href && <SeeLink href={s.href} label={s.title} />}
                </div>
              );
            })
          )}
        </div>
      )}
    </Panel>
  );
}

/** Lien « voir » : ouvre la source (cours / série / exercice / annale) à sa page. */
function SeeLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Ouvrir : ${label}`}
      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-line bg-surface-2/40 px-2.5 text-[0.78rem] font-medium text-ink-2 transition-colors hover:border-[color-mix(in_oklch,var(--color-violet)_40%,transparent)] hover:text-violet-hi focus-visible:outline-2 focus-visible:outline-violet focus-visible:outline-offset-2"
    >
      voir
      <ArrowUpRight className="size-3.5" strokeWidth={2.25} />
    </a>
  );
}

/** Case à cocher accessible « annale de référence ». */
function RefCheckbox({ checked, busy, onToggle, label }: { checked: boolean; busy: boolean; onToggle: () => void; label: string }) {
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
        className={cn("grid size-4 place-items-center rounded-[5px] border transition-colors", checked ? "border-transparent bg-violet-deep text-white" : "border-line-strong bg-surface-1")}
      >
        {checked && <Check className="size-3" strokeWidth={3} />}
      </span>
      Référence
    </button>
  );
}

function FacetChip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
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
