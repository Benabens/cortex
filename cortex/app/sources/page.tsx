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

const INGEST_ACTIVE = ["queued", "running", "verifying", "compiling"];

export default function SourcesPage() {
  const [exams, setExams] = useState<ExamSource[]>([]);
  const [corpus, setCorpus] = useState<Corpus[]>([]);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // import de dossier (cours additionnels)
  const [course, setCourse] = useState("cs-202");
  const [importPath, setImportPath] = useState("");
  const [importJob, setImportJob] = useState<any>(null);
  const [importErr, setImportErr] = useState<string | null>(null);
  const importPoll = useRef<any>(null);

  const load = useCallback(async () => {
    const d = await (await fetch("/api/sources")).json();
    setExams(d.exams ?? []);
    setCorpus(d.corpus ?? []);
  }, []);

  const pollImport = useCallback((id: number) => {
    clearInterval(importPoll.current);
    importPoll.current = setInterval(async () => {
      try {
        const j = await (await fetch(`/api/jobs/${id}`)).json();
        setImportJob(j);
        if (!INGEST_ACTIVE.includes(j.status)) { clearInterval(importPoll.current); if (j.status === "done") load(); }
      } catch {}
    }, 1500);
  }, [load]);

  useEffect(() => {
    load();
    try { setCourse(localStorage.getItem("cortex-course") || "cs-202"); } catch {}
    (async () => {
      try {
        const d = await (await fetch("/api/jobs?type=ingest")).json();
        if (d.active && INGEST_ACTIVE.includes(d.active.status)) { setImportJob(d.active); pollImport(d.active.id); }
      } catch {}
    })();
    return () => clearInterval(importPoll.current);
  }, [load, pollImport]);

  async function startImport() {
    if (!importPath.trim()) return;
    setImportErr(null);
    setImportJob(null);
    try {
      const r = await fetch("/api/sources/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: importPath.trim() }) });
      const d = await r.json();
      if (!r.ok) { setImportErr(d.error ?? "Échec"); return; }
      if (d.jobId) { setImportJob({ id: d.jobId, status: "queued", progress: 0, currentStep: "Démarrage…", log: [] }); pollImport(d.jobId); }
    } catch (e: any) { setImportErr(String(e.message ?? e)); }
  }

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
      <header className="mb-6 rise">
        <p className="eyebrow">Sources</p>
        <h1 className="h1 mt-2" style={{ fontSize: 28 }}>Les examens qui servent de modèle.</h1>
        <p className="sub mt-3">
          Coche les examens (idéalement des 3 dernières années) que tu juges les plus représentatifs.
          La génération s'appuie <strong style={{ color: "var(--ink)" }}>en priorité</strong> sur leur format —
          types de questions, structure, analyse de code — en puisant le contenu dans tout ton corpus.
        </p>
      </header>

      {/* Import d'un DOSSIER entier (cours additionnels uniquement) */}
      {course !== "cs-202" && (
        <div className="card card-pad mb-5">
          <h2 className="text-[15px] font-semibold mb-1" style={{ color: "var(--ink)" }}>📂 Importer un dossier entier</h2>
          <p className="text-[13px] mb-3" style={{ color: "var(--ink-2)" }}>
            Donne le chemin d'un dossier (cours, séries+corrigés, sites, <strong style={{ color: "var(--ink)" }}>vrais examens</strong>, images d'exos).
            Cortex classe tout, détecte les examens de référence et indexe la matière. Cours courant : <strong style={{ color: "var(--accent-ink)" }}>{course}</strong>.
          </p>
          {importJob && INGEST_ACTIVE.includes(importJob.status) ? (
            <div>
              <div className="progress">
                <div className="progress-bar" style={{ width: `${importJob.progress}%` }} />
              </div>
              <div className="mt-2 text-[13px]" style={{ color: "var(--ink-2)" }}>{importJob.currentStep}</div>
            </div>
          ) : (
            <div className="flex gap-2">
              <input className="input" placeholder="/Users/ben/Documents/Cowork/ALGO 1" value={importPath} onChange={(e) => setImportPath(e.target.value)} style={{ fontSize: 14 }} />
              <button className="btn btn-primary" onClick={startImport}>Importer</button>
            </div>
          )}
          {importJob?.status === "done" && (
            <div className="mt-3">
              <p className="text-[13px]" style={{ color: "var(--green)" }}>Dossier ingéré ✓</p>
              {importJob.log?.length > 0 && (
                <div className="mt-2 rounded-lg p-2 text-[11px] leading-relaxed max-h-40 overflow-auto" style={{ background: "var(--surface-2)", color: "var(--ink-3)", fontFamily: "ui-monospace, monospace" }}>
                  {importJob.log.filter((l: any) => /Compris|examens de référence|types|conventions|importé|refs|lectures|series|notes|sites|images/.test(l.msg)).slice(-12).map((l: any, i: number) => <div key={i}>{l.msg}</div>)}
                </div>
              )}
            </div>
          )}
          {importJob?.status === "error" && <p className="mt-2 text-[12px]" style={{ color: "var(--red)" }}>Échec : {importJob.error}</p>}
          {importErr && <p className="mt-2 text-[12px]" style={{ color: "var(--red)" }}>{importErr}</p>}
        </div>
      )}

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
