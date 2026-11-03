"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { useApi, useCourse } from "@/lib/ux/api";
import { hitHref, type SearchResp } from "@/lib/ux/search";

export function HeaderSearch() {
  const { courseId } = useCourse();
  return <SearchField key={courseId} courseId={courseId} />;
}

function SearchField({ courseId }: { courseId: string }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const { data, loading, error } = useApi<SearchResp>(
    debounced.length >= 2 ? `/api/search?q=${encodeURIComponent(debounced)}` : null
  );
  const hits = data?.groups.flatMap((group) => group.hits).slice(0, 6) ?? [];
  const ready = query.trim() === debounced;
  return (
    <div className="relative hidden max-w-[480px] flex-1 sm:block"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3 size-4 text-ink-3" />
      <input role="combobox" aria-label="Rechercher dans le cours" aria-autocomplete="list"
        aria-expanded={open && query.trim().length >= 2} aria-controls={id}
        aria-activedescendant={open && ready && hits[selected] ? `${id}-${selected}` : undefined}
        value={query} placeholder="Rechercher dans ton cours…"
        className="h-10 w-full rounded-full border border-line bg-bg pl-10 pr-4 text-sm text-ink-1 placeholder:text-ink-3"
        onFocus={() => setOpen(true)}
        onChange={(event) => { setQuery(event.target.value); setSelected(0); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
          if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setSelected((value) => Math.min(value + 1, Math.max(0, hits.length - 1))); }
          if (event.key === "ArrowUp") { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)); }
          if (event.key === "Enter" && ready && hits[selected]) {
            event.preventDefault();
            window.location.assign(hitHref(courseId, hits[selected], debounced));
          }
        }} />
      {open && query.trim().length >= 2 && (
        <div className="absolute inset-x-0 top-12 overflow-hidden rounded-2xl border border-line-strong bg-surface-2 p-2 shadow-[var(--shadow-pop)]">
          <ul id={id} role="listbox" aria-label="Résultats de recherche">
            {!ready || loading ? <li role="presentation" className="p-3 text-sm text-ink-3">Recherche…</li> :
              error ? <li role="presentation" className="p-3 text-sm text-danger-hi">Recherche indisponible. Réessaie dans un instant.</li> :
                hits.length ? hits.map((hit, index) => (
                  <li key={hit.itemId} id={`${id}-${index}`} role="option" aria-selected={selected === index}>
                    <a href={hitHref(courseId, hit, debounced)} onMouseEnter={() => setSelected(index)}
                      className={`block rounded-xl px-3 py-2 text-sm ${selected === index ? "bg-violet/15 text-violet-hi" : "text-ink-1"}`}>
                      <span className="block truncate font-medium">{hit.title}</span>
                      <span className="block truncate text-xs text-ink-3">{hit.sourceTitle}</span>
                    </a>
                  </li>
                )) : <li role="presentation" className="p-3 text-sm text-ink-3">Aucun résultat pour cette recherche.</li>}
          </ul>
          <Link href="/recherche" className="mt-1 flex min-h-11 items-center border-t border-line px-3 text-sm text-violet-hi">Ouvrir la recherche complète →</Link>
        </div>
      )}
    </div>
  );
}
