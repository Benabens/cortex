"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X, CornerDownLeft, Sparkles, SlidersHorizontal, WifiOff } from "lucide-react";
import { useApi, useCourse } from "@/lib/ux/api";
import { SUGGEST, metaFor, hitHref, snippetParts, type SearchResp, type Hit } from "@/lib/ux/search";
import { toneVar } from "@/lib/ux/labels";
import { Kbd } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/ux/cn";

const MIN_CHARS = 2;

/** Segment « … » du snippet FTS → <mark>. */
function Snippet({ text }: { text: string }) {
  const parts = useMemo(() => snippetParts(text), [text]);
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark
            key={i}
            className="rounded bg-[color-mix(in_oklch,var(--color-violet)_30%,transparent)] px-0.5 text-ink-1"
          >
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  );
}

/** Recherche full-text RÉELLE sur tout le corpus du cours (GET /api/search?q=). */
export function SearchExperience() {
  const { courseId } = useCourse();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [activeType, setActiveType] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  // Recherche live, débouncée (250 ms), dès 2 caractères.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const active = debounced.length >= MIN_CHARS;
  const { data, loading, error, refetch } = useApi<SearchResp>(
    active ? `/api/search?q=${encodeURIComponent(debounced)}` : null
  );

  const groups = useMemo(() => {
    if (!data) return [];
    return activeType ? data.groups.filter((g) => g.sourceType === activeType) : data.groups;
  }, [data, activeType]);

  // Liste plate ordonnée pour la navigation clavier (l'index traverse les groupes).
  const flat: Hit[] = useMemo(() => groups.flatMap((g) => g.hits), [groups]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setSelected(0);
  }, [debounced, activeType, courseId]);
  useEffect(() => {
    setActiveType(null);
  }, [debounced, courseId]);

  // clavier : focus (⌘K / "/"), naviguer (↑↓), ouvrir (↵), effacer (Échap)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement === inputRef.current;
      if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing)) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => Math.min(flat.length - 1, s + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => Math.max(0, s - 1));
      } else if (e.key === "Enter" && flat[selected]) {
        e.preventDefault();
        window.open(hitHref(courseId, flat[selected], debounced), "_blank", "noopener");
      } else if (e.key === "Escape") {
        if (query) {
          e.preventDefault();
          setQuery("");
        } else {
          inputRef.current?.blur();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flat, selected, query, debounced, courseId]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const suggestions = SUGGEST[courseId] ?? [];
  const shownCount = flat.length;

  return (
    <div className="flex flex-col gap-5">
      {/* Barre de recherche — sobre : bord 1 px, focus net, AUCUN halo (P0.1) */}
      <div>
        <div className="group relative flex items-center gap-3 rounded-xl border border-line-strong bg-surface-1/80 px-4 transition-[border-color,box-shadow] duration-150 focus-within:border-[color-mix(in_oklch,var(--color-violet)_60%,transparent)] focus-within:[box-shadow:inset_0_0_0_1px_color-mix(in_oklch,var(--color-violet)_45%,transparent)]">
          <Search className="size-5 shrink-0 text-ink-3 transition-colors group-focus-within:text-ink-2" strokeWidth={2} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            type="text"
            role="searchbox"
            data-focus-parent
            aria-label="Rechercher dans tout ton corpus"
            placeholder="Rechercher un cours, une série, un final…"
            className="h-13 min-w-0 flex-1 truncate bg-transparent text-[1rem] text-ink-1 placeholder:text-ink-4 focus:outline-none focus-visible:outline-none"
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label="Effacer la recherche"
              className="grid size-8 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-1"
            >
              <X className="size-4" />
            </button>
          ) : (
            <span className="hidden items-center gap-1 sm:flex">
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </span>
          )}
        </div>
        {/* raccourcis, discrets sous la barre — l'écran se lit « prêt » */}
        {!active && (
          <p className="mt-2 px-1 text-[0.74rem] text-ink-4">
            <Kbd className="mr-1">↑</Kbd>
            <Kbd className="mr-1.5">↓</Kbd>
            naviguer
            <span className="mx-2 text-ink-4">·</span>
            <Kbd className="mr-1.5">↵</Kbd>
            ouvrir
            <span className="mx-2 text-ink-4">·</span>
            dès {MIN_CHARS} caractères, sur tout ton corpus
          </p>
        )}
      </div>

      {/* État vide INTENTIONNEL (P0.3) : compact, utile — les suggestions SONT le contenu */}
      {!active && (
        <section aria-label="Suggestions de recherche" className="flex flex-col gap-2.5">
          <span className="inline-flex items-center gap-1.5 text-[0.72rem] font-medium uppercase tracking-wider text-ink-4">
            <Sparkles className="size-3.5 text-violet-hi" strokeWidth={2.25} />
            Essaie
          </span>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setQuery(s);
                  inputRef.current?.focus();
                }}
                className="inline-flex min-h-10 items-center rounded-full border border-line bg-surface-1/70 px-3.5 text-[0.85rem] text-ink-2 transition-colors duration-150 hover:border-[color-mix(in_oklch,var(--color-violet)_38%,transparent)] hover:bg-surface-2 hover:text-ink-1"
              >
                {s}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Facettes (groupes réels renvoyés par le back) + compteur */}
      {active && data && data.groups.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 inline-flex items-center gap-1.5 text-[0.72rem] font-medium uppercase tracking-wider text-ink-4">
              <SlidersHorizontal className="size-3.5" strokeWidth={2.25} />
              Type
            </span>
            <TypeChip
              label="Tous"
              count={data.total}
              active={activeType === null}
              onClick={() => setActiveType(null)}
            />
            {data.groups.map((g) => {
              const meta = metaFor(g.sourceType);
              return (
                <TypeChip
                  key={g.sourceType}
                  label={g.label}
                  count={g.hits.length}
                  tone={toneVar[meta.tone]}
                  Icon={meta.Icon}
                  active={activeType === g.sourceType}
                  onClick={() => setActiveType(activeType === g.sourceType ? null : g.sourceType)}
                />
              );
            })}
          </div>
          <span className="text-[0.8rem] text-ink-3" aria-live="polite">
            <span className="font-data font-semibold text-ink-1">{shownCount}</span> résultat
            {shownCount > 1 ? "s" : ""} pour «&nbsp;{debounced}&nbsp;»
          </span>
        </div>
      )}

      {/* Résultats — rien à afficher tant que la requête est trop courte (l'état vide vit au-dessus) */}
      {!active ? null : loading ? (
        <div className="panel space-y-2 rounded-xl p-3" aria-busy="true" aria-label="Recherche en cours">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3 px-2 py-1.5">
              <div className="skeleton size-9 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <div className="skeleton h-3.5 w-2/3" />
                <div className="skeleton h-3 w-5/6" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="panel flex flex-col items-center gap-3 rounded-xl px-6 py-12 text-center">
          <WifiOff className="size-6 text-danger-hi" strokeWidth={2} />
          <p className="text-[0.95rem] font-medium text-ink-1">La recherche ne répond pas</p>
          <p className="max-w-xs text-[0.85rem] text-ink-3">Réessaie dans un instant.</p>
          <Button variant="secondary" size="sm" onClick={refetch}>
            Réessayer
          </Button>
        </div>
      ) : flat.length === 0 ? (
        <div className="panel grid place-items-center rounded-xl px-6 py-16 text-center">
          <Search className="size-7 text-ink-4" strokeWidth={1.75} />
          <p className="mt-3 text-[0.95rem] font-medium text-ink-1">
            Aucun résultat pour «&nbsp;{debounced}&nbsp;»
          </p>
          <p className="mt-1 max-w-xs text-[0.85rem] text-ink-3">
            {activeType
              ? "Retire le filtre de type, ou essaie un autre terme."
              : "Essaie un autre terme. Tes annales sont peut-être à importer dans Sources."}
          </p>
          {activeType && (
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => setActiveType(null)}>
              Retirer le filtre
            </Button>
          )}
        </div>
      ) : (
        <div ref={listRef} className="panel overflow-hidden rounded-xl p-1.5">
          {(() => {
            let idx = -1;
            return groups.map((g) => (
              <div key={g.sourceType}>
                <div className="flex items-center gap-2 px-3 pb-1 pt-3 text-[0.7rem] font-medium uppercase tracking-wider text-ink-4">
                  {g.label}
                  <span className="font-data normal-case text-ink-4">{g.hits.length}</span>
                </div>
                {g.hits.map((h) => {
                  idx += 1;
                  const i = idx;
                  const meta = metaFor(h.sourceType);
                  const isSel = i === selected;
                  return (
                    <a
                      key={`${h.itemId}-${i}`}
                      href={hitHref(courseId, h, debounced)}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-idx={i}
                      onMouseMove={() => setSelected(i)}
                      aria-label={`${g.label} : ${h.title}`}
                      className={cn(
                        "group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors",
                        isSel ? "bg-surface-2" : "hover:bg-surface-2/60"
                      )}
                    >
                      <span
                        className="grid size-9 shrink-0 place-items-center rounded-lg border border-line"
                        style={{
                          background: `color-mix(in oklch, ${toneVar[meta.tone]} 12%, var(--color-surface-2))`,
                          color: toneVar[meta.tone],
                        }}
                      >
                        <meta.Icon className="size-[1.1rem]" strokeWidth={2} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[0.92rem] font-medium text-ink-1">{h.title}</div>
                        <div className="truncate text-[0.78rem] text-ink-3">
                          <Snippet text={h.snippet} />
                        </div>
                      </div>
                      <span
                        className={cn(
                          "shrink-0 items-center gap-1 text-[0.72rem] text-ink-3",
                          isSel ? "flex" : "hidden md:group-hover:flex"
                        )}
                      >
                        <CornerDownLeft className="size-3.5" strokeWidth={2.25} /> Ouvrir
                      </span>
                    </a>
                  );
                })}
              </div>
            ));
          })()}
        </div>
      )}
    </div>
  );
}

function TypeChip({
  label,
  count,
  active,
  onClick,
  tone,
  Icon,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  tone?: string;
  Icon?: React.ComponentType<{ className?: string; strokeWidth?: number }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-full border px-3 text-[0.82rem] font-medium transition-colors",
        active
          ? "border-[color-mix(in_oklch,var(--color-violet)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-violet)_14%,transparent)] text-ink-1"
          : "border-line bg-surface-1/60 text-ink-2 hover:bg-surface-2 hover:text-ink-1"
      )}
    >
      {Icon && <Icon className="size-3.5" strokeWidth={2.25} />}
      <span style={active && tone ? { color: tone } : undefined}>{label}</span>
      <span className="font-data text-[0.72rem] tabular text-ink-4">{count}</span>
    </button>
  );
}
