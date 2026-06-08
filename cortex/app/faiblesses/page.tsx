"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Related = {
  itemId: number;
  title: string | null;
  sourceType: string;
  sourceTitle: string;
  lectureId: string | null;
  href: string;
};
type Weakness = {
  id: number;
  topic: string;
  description: string | null;
  screenshotUrl: string | null;
  severity: number;
  analyzed: boolean;
  loggedAt: string | null;
  related: Related[];
};

const SEV = [
  { v: 1, label: "léger", color: "var(--green)" },
  { v: 2, label: "moyen", color: "var(--accent)" },
  { v: 3, label: "gros", color: "var(--red)" },
];

export default function FaiblessesPage() {
  const [list, setList] = useState<Weakness[]>([]);
  const [topic, setTopic] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState(2);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/weaknesses");
    const d = await r.json();
    setList(d.weaknesses ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  function pickFile(f: File | null) {
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
  }

  // Coller une image depuis le presse-papier (Cmd+Shift+4 → coller)
  const onPaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) {
          pickFile(new File([f], `screenshot.${f.type.split("/")[1] || "png"}`, { type: f.type }));
          e.preventDefault();
        }
      }
    }
  }, []);
  useEffect(() => {
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onPaste]);

  const canSubmit = !!(topic.trim() || description.trim() || file);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.set("topic", topic);
      fd.set("description", description);
      fd.set("severity", String(severity));
      if (file) fd.set("screenshot", file);
      const r = await fetch("/api/weaknesses", { method: "POST", body: fd });
      if (!r.ok) throw new Error((await r.json()).error ?? "Échec");
      setTopic("");
      setDescription("");
      setSeverity(2);
      pickFile(null);
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function analyze(id: number) {
    setAnalyzing(id);
    setErr(null);
    try {
      const r = await fetch("/api/weaknesses/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Échec analyse");
      await load();
    } catch (e: any) {
      setErr(String(e.message ?? e).includes("ANTHROPIC_API_KEY") ? "Ajoute ta clé API dans cortex/.env.local pour activer l'analyse Claude." : String(e.message ?? e));
    } finally {
      setAnalyzing(null);
    }
  }

  async function remove(id: number) {
    await fetch(`/api/weaknesses?id=${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <main className="page page-narrow">
      <header className="mb-6">
        <p className="eyebrow">Faiblesses</p>
        <h1 className="h1 mt-2" style={{ fontSize: 28 }}>Tes points faibles, capturés.</h1>
      </header>

      {/* Formulaire d'intake */}
      <form onSubmit={submit} className="card card-pad mb-8">
        <p className="mb-4 text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
          Dépose juste un <strong style={{ color: "var(--ink)" }}>screenshot de l'exo</strong> — l'IA comprend tout, pas besoin d'expliquer. Ou écris une note (ex. « j'ai du mal avec le code fork / pthread »). Le sujet est optionnel.
        </p>
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Sujet (optionnel — l'IA le déduit du screenshot)"
          className="input mb-3"
          style={{ fontSize: 14 }}
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optionnel : ce que tu n'as pas compris…"
          rows={3}
          className="textarea mb-3"
          style={{ fontSize: 14 }}
        />
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="flex gap-1.5">
            {SEV.map((s) => (
              <button
                key={s.v}
                type="button"
                onClick={() => setSeverity(s.v)}
                className="chip"
                style={{
                  borderColor: severity === s.v ? s.color : "var(--line-strong)",
                  color: severity === s.v ? s.color : "var(--ink-2)",
                  fontWeight: severity === s.v ? 600 : 400,
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
          <label className="cursor-pointer">
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
            <span className="chip">📎 screenshot</span>
          </label>
          <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>…ou colle une image (Cmd+V)</span>
        </div>
        {preview && (
          <img src={preview} alt="aperçu" className="mb-3 max-h-40 rounded-lg border" style={{ borderColor: "var(--line)" }} />
        )}
        <button type="submit" disabled={saving || !canSubmit} className="btn btn-primary">
          {saving ? "Enregistrement…" : "Ajouter la faiblesse"}
        </button>
        {err && <p className="mt-2.5 text-[12px]" style={{ color: "var(--red)" }}>{err}</p>}
      </form>

      {/* Bandeau : faiblesses à analyser par l'IA */}
      {list.some((w) => !w.analyzed) && (
        <div className="mb-5 rounded-xl px-4 py-3 text-[13px] leading-relaxed" style={{ background: "var(--accent-wash)", color: "var(--ink-2)" }}>
          <strong style={{ color: "var(--accent-ink)" }}>{list.filter((w) => !w.analyzed).length} faiblesse(s) à analyser.</strong>{" "}
          Dis à Claude Code « <em>analyse mes faiblesses</em> » (gratuit, via ton Max) — il lit tes screenshots et remplit tout. Ou clique ✦ sur une carte (utilise l'API, payant).
        </div>
      )}

      {/* Liste */}
      <div className="space-y-4">
        {list.length === 0 && (
          <p className="text-[14px]" style={{ color: "var(--ink-3)" }}>
            Aucune faiblesse pour l'instant. Ajoute un exo raté ci-dessus.
          </p>
        )}
        {list.map((w) => {
          const sev = SEV.find((s) => s.v === w.severity) ?? SEV[1];
          return (
            <div key={w.id} className="card card-pad">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="dot" style={{ background: sev.color }} />
                  <h3 className="text-[15px] font-semibold" style={{ color: "var(--ink)" }}>{w.topic}</h3>
                  {!w.analyzed && <span className="badge">à analyser</span>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button onClick={() => analyze(w.id)} disabled={analyzing === w.id} className="btn btn-quiet" style={{ color: "var(--blue)" }}>
                    {analyzing === w.id ? "analyse…" : "✦ analyser"}
                  </button>
                  <button onClick={() => remove(w.id)} className="btn btn-quiet">suppr</button>
                </div>
              </div>
              {w.screenshotUrl && (
                <img src={w.screenshotUrl} alt="" className="mt-3 max-h-56 rounded-lg border" style={{ borderColor: "var(--line)" }} />
              )}
              {w.description && (
                <p className="mt-3 whitespace-pre-wrap text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>{w.description}</p>
              )}
              {w.related.length > 0 && (
                <div className="mt-4">
                  <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: "var(--ink-3)" }}>À revoir dans ton corpus</div>
                  <ul className="flex flex-wrap gap-1.5">
                    {w.related.map((r) => (
                      <li key={r.itemId}>
                        <a href={r.href} target="_blank" rel="noopener" className="chip" style={{ color: "var(--ink-2)" }}>
                          {r.lectureId ? r.lectureId.toUpperCase() + " · " : ""}{(r.title ?? r.sourceTitle).slice(0, 42)}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}
