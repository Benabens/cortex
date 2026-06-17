"use client";

import { sourceHref } from "@/lib/deeplink";
import { useEffect, useRef, useState } from "react";

type Hit = {
  itemId: number;
  sourceType: string;
  sourceTitle: string;
  sourcePath: string;
  lectureId: string | null;
  title: string | null;
  anchor: string;
  snippet: string;
};

/** Clic→source UNIFIÉ (lib/deeplink) : cs-202 → viewer/sites (inchangé) ; autres → /csrc. */
function hitHref(h: Hit, q: string, course: string): string {
  return sourceHref(course, h.sourcePath, h.anchor, { itemId: h.itemId, q });
}
type Group = { sourceType: string; label: string; hits: Hit[] };

// V10 — suggestions de recherche COURSE-AWARE (plus de topics CS-202 affichés sur ML/Algo).
const SUGGEST: Record<string, string[]> = {
  "cs-202": ["memory image", "fork", "TCP slow start", "inode", "page fault", "longest prefix", "scheduling"],
  ml: ["overfitting", "SVM", "K-means", "gradient descent", "backprop", "PCA", "régularisation"],
  algo: ["Master Theorem", "Dijkstra", "dynamic programming", "BFS / DFS", "greedy", "SCC", "complexité"],
};

const ACCENT: Record<string, string> = {
  review: "var(--green)",
  course_pdf: "var(--blue)",
  final: "var(--accent)",
  midterm: "var(--accent)",
  serie: "var(--blue)",
  exercise: "var(--blue)",
  cheatsheet: "var(--ink-3)",
};

/** Rend le snippet FTS (marqueurs « ») avec surlignage. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("«") && p.endsWith("»") ? (
          <mark key={i}>{p.slice(1, -1)}</mark>
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
  const [course, setCourse] = useState("cs-202");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    try { setCourse(localStorage.getItem("cortex-course") || "cs-202"); } catch {}
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
    <main className="page page-narrow">
      <header className="mb-6 rise">
        <p className="eyebrow">Recherche globale</p>
        <h1 className="h1 mt-2" style={{ fontSize: 28 }}>Cherche partout, d'un coup.</h1>
        <p className="sub mt-2">Un Ctrl-F universel sur tous tes supports — cours, séries, finals, cheat sheets, code des labs.</p>
      </header>

      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`ex. ${(SUGGEST[course] ?? SUGGEST["cs-202"]).slice(0, 3).join(", ")}…`}
        className="input"
        style={{ fontSize: 16, padding: "13px 16px" }}
      />
      <p className="mt-2.5 h-4 text-[13px]" style={{ color: "var(--ink-3)" }}>
        {loading ? <><span className="spinner" /> recherche…</> : searched ? `${total} résultat${total > 1 ? "s" : ""} dans tous tes supports` : "reviews · exos · finals · cheatsheets · slides de cours"}
      </p>

      {/* état vide : suggestions cliquables */}
      {!searched && !loading && (
        <div className="mt-6">
          <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--ink-3)", letterSpacing: "0.04em" }}>Essaie</p>
          <div className="flex flex-wrap gap-1.5">
            {(SUGGEST[course] ?? SUGGEST["cs-202"]).map((s) => (
              <button key={s} className="chip" style={{ cursor: "pointer" }} onClick={() => { setQ(s); inputRef.current?.focus(); }}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-7 space-y-8">
        {groups.map((g) => (
          <section key={g.sourceType}>
            <h2 className="mb-3 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--ink-2)", letterSpacing: "0.04em" }}>
              <span className="dot" style={{ background: ACCENT[g.sourceType] ?? "var(--ink-3)" }} />
              {g.label}
              <span style={{ color: "var(--ink-3)" }}>· {g.hits.length}</span>
            </h2>
            <ul className="space-y-2.5">
              {g.hits.map((h) => (
                <li key={h.itemId}>
                  <a href={hitHref(h, q, course)} target="_blank" rel="noopener" className="card-link" style={{ padding: "14px 16px", borderRadius: "var(--r)" }}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-[14px] font-semibold" style={{ color: "var(--ink)" }}>
                        {h.title || h.sourceTitle}
                      </span>
                      <span className="shrink-0 text-[11px]" style={{ color: "var(--ink-3)" }}>
                        {h.lectureId ? h.lectureId.toUpperCase() + " · " : ""}
                        {h.sourceTitle}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
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
