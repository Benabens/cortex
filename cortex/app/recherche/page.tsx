"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Hit = {
  itemId: number;
  sourceType: string;
  sourceTitle: string;
  lectureId: string | null;
  title: string | null;
  anchor: string;
  snippet: string;
};
type Group = { sourceType: string; label: string; hits: Hit[] };

const ACCENT: Record<string, string> = {
  review: "var(--color-accent-tree)",
  course_pdf: "var(--color-accent-soft)",
  final: "var(--color-accent)",
  midterm: "var(--color-accent)",
  serie: "var(--color-accent-soft)",
  exercise: "var(--color-accent-soft)",
  cheatsheet: "var(--color-text-secondary)",
};

/** Rend le snippet FTS (marqueurs « ») avec surlignage. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("«") && p.endsWith("»") ? (
          <mark key={i} style={{ background: "transparent", color: "var(--color-accent)", fontWeight: 600 }}>
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

export default function RecherchePage() {
  const [q, setQ] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) {
      setGroups([]);
      setTotal(0);
      setSearched(false);
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        const data = await res.json();
        setGroups(data.groups);
        setTotal(data.total);
        setSearched(true);
      } catch {
        /* annulé */
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="mb-6 flex items-center gap-3 text-sm">
        <Link href="/" style={{ color: "var(--color-text-tertiary)" }}>
          ← Cortex
        </Link>
        <span style={{ color: "var(--color-text-tertiary)" }}>/ Recherche globale</span>
      </div>

      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="ex. memory image, fork, TCP, page fault…"
        className="w-full rounded-lg border px-4 py-3 text-base outline-none"
        style={{
          background: "var(--color-bg-secondary)",
          borderColor: "var(--color-border)",
          color: "var(--color-text-primary)",
        }}
      />
      <p className="mt-2 h-4 text-xs" style={{ color: "var(--color-text-tertiary)" }}>
        {loading ? "recherche…" : searched ? `${total} résultat${total > 1 ? "s" : ""} dans tous tes supports` : "Cherche à travers reviews, exos, finals, cheatsheets et slides de cours."}
      </p>

      <div className="mt-6 space-y-8">
        {groups.map((g) => (
          <section key={g.sourceType}>
            <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--color-text-secondary)" }}>
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: ACCENT[g.sourceType] ?? "var(--color-text-secondary)" }} />
              {g.label}
              <span style={{ color: "var(--color-text-tertiary)" }}>· {g.hits.length}</span>
            </h2>
            <ul className="space-y-2">
              {g.hits.map((h) => (
                <li key={h.itemId}>
                  <a
                    href={`/sites/${h.anchor}`}
                    target="_blank"
                    rel="noopener"
                    className="block rounded-md border px-4 py-3 transition-colors hover:brightness-125"
                    style={{ borderColor: "var(--color-border)", background: "var(--color-bg-secondary)" }}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>
                        {h.title || h.sourceTitle}
                      </span>
                      <span className="shrink-0 text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
                        {h.lectureId ? h.lectureId.toUpperCase() + " · " : ""}
                        {h.sourceTitle}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
                      <Snippet text={h.snippet} />
                    </p>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
