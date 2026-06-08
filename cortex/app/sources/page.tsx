"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ExamSource = {
  path: string;
  title: string;
  year: number | null;
  kind: string;
  items: number;
  uploaded: boolean;
  isReference: boolean;
};
type Corpus = { type: string; sources: number; items: number };

const TYPE_FR: Record<string, string> = {
  review: "Reviews", course_pdf: "Cours (PDF)", final: "Finals", midterm: "Midterms",
  serie: "Séries", exercise: "Exercices", cheatsheet: "Cheat sheets", code: "Code C",
  lab: "Labs", note: "Notes", doc: "Docs",
};

export default function SourcesPage() {
  const [exams, setExams] = useState<ExamSource[]>([]);
  const [corpus, setCorpus] = useState<Corpus[]>([]);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const d = await (await fetch("/api/sources")).json();
    setExams(d.exams ?? []);
    setCorpus(d.corpus ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function toggle(path: string, reference: boolean) {
    setExams((xs) => xs.map((e) => (e.path === path ? { ...e, isReference: reference } : e)));
    await fetch("/api/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, reference }),
    });
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setErr(null);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.set("file", file);
        const r = await fetch("/api/sources", { method: "POST", body: fd });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Échec");
      }
      await load();
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeUploaded(path: string) {
    await fetch(`/api/sources?path=${encodeURIComponent(path)}`, { method: "DELETE" });
    await load();
  }

  const refCount = exams.filter((e) => e.isReference).length;

  return (
    <main className="page page-narrow">
      <header className="mb-6">
        <p className="eyebrow">Sources</p>
        <h1 className="h1 mt-2" style={{ fontSize: 28 }}>Les examens qui servent de modèle.</h1>
        <p className="sub mt-3">
          Coche les examens (idéalement des 3 dernières années) que tu juges les plus représentatifs.
          La génération s'appuie <strong style={{ color: "var(--ink)" }}>en priorité</strong> sur leur format —
          types de questions, structure, analyse de code — en puisant le contenu dans tout ton corpus.
        </p>
      </header>

      {/* Upload */}
      <div
        className="card mb-7"
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files); }}
        style={{
          padding: 22,
          borderStyle: "dashed",
          borderColor: drag ? "var(--accent)" : "var(--line-strong)",
          background: drag ? "var(--accent-wash)" : "var(--surface)",
          textAlign: "center",
          transition: "all .15s",
        }}
      >
        <p className="text-[14px] font-medium" style={{ color: "var(--ink)" }}>
          Glisse un examen ici, ou
          <button className="btn btn-ghost" style={{ marginLeft: 8, padding: "4px 12px" }} onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? "indexation…" : "choisir un fichier"}
          </button>
        </p>
        <p className="mt-2 text-[12px]" style={{ color: "var(--ink-3)" }}>
          PDF, HTML, TXT ou MD · indexé et coché comme référence automatiquement
        </p>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".pdf,.html,.htm,.txt,.md"
          className="hidden"
          onChange={(e) => upload(e.target.files)}
        />
        {err && <p className="mt-2 text-[12px]" style={{ color: "var(--red)" }}>{err}</p>}
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--ink-2)", letterSpacing: "0.04em" }}>
          Examens disponibles
        </h2>
        <span className="text-[12px]" style={{ color: refCount ? "var(--accent-ink)" : "var(--ink-3)" }}>
          {refCount} référence{refCount > 1 ? "s" : ""} active{refCount > 1 ? "s" : ""}
        </span>
      </div>

      {refCount === 0 && (
        <p className="mb-4 rounded-xl px-4 py-3 text-[13px]" style={{ background: "var(--accent-wash)", color: "var(--ink-2)" }}>
          Aucune référence cochée → la génération se base par défaut sur les 2 examens les plus récents.
        </p>
      )}

      <ul className="space-y-2.5">
        {exams.length === 0 && (
          <li className="text-[14px]" style={{ color: "var(--ink-3)" }}>Aucun examen dans le corpus.</li>
        )}
        {exams.map((e) => (
          <li key={e.path}>
            <label className="card flex cursor-pointer items-center gap-3" style={{ padding: "13px 16px" }}>
              <input
                type="checkbox"
                checked={e.isReference}
                onChange={(ev) => toggle(e.path, ev.target.checked)}
                style={{ width: 18, height: 18, accentColor: "var(--accent)", flex: "none" }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[14px] font-semibold" style={{ color: "var(--ink)" }}>
                    {e.title}
                  </span>
                  {e.uploaded && <span className="badge">uploadé</span>}
                </div>
                <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>
                  {e.kind === "midterm" ? "Midterm" : "Final"}
                  {e.year ? ` · ${e.year}` : ""} · {e.items} extrait{e.items > 1 ? "s" : ""}
                </span>
              </div>
              <a
                href={e.uploaded ? `/refs/${e.path.split("/").pop()}` : `/voir?src=${encodeURIComponent(e.path)}`}
                target="_blank"
                rel="noopener"
                onClick={(ev) => ev.stopPropagation()}
                className="btn btn-quiet"
                style={{ color: "var(--blue)" }}
              >
                ouvrir
              </a>
              {e.uploaded && (
                <button
                  onClick={(ev) => { ev.preventDefault(); removeUploaded(e.path); }}
                  className="btn btn-quiet"
                >
                  suppr
                </button>
              )}
            </label>
          </li>
        ))}
      </ul>

      {/* Récap corpus */}
      {corpus.length > 0 && (
        <>
          <hr className="divider" style={{ margin: "32px 0 18px" }} />
          <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--ink-2)", letterSpacing: "0.04em" }}>
            Ce que Cortex a indexé
          </h2>
          <div className="flex flex-wrap gap-2">
            {corpus.map((c) => (
              <span key={c.type} className="chip">
                {TYPE_FR[c.type] ?? c.type}
                <span style={{ color: "var(--ink-3)" }}>· {c.items}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
