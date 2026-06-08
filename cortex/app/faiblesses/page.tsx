"use client";

import Link from "next/link";
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
  { v: 1, label: "léger", color: "var(--color-accent-tree)" },
  { v: 2, label: "moyen", color: "var(--color-accent)" },
  { v: 3, label: "gros", color: "#d9774f" },
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
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="mb-6 flex items-center gap-3 text-sm">
        <Link href="/" style={{ color: "var(--color-text-tertiary)" }}>← Cortex</Link>
        <span style={{ color: "var(--color-text-tertiary)" }}>/ Faiblesses</span>
      </div>

      {/* Formulaire d'intake */}
      <form onSubmit={submit} className="mb-8 rounded-lg border p-4" style={{ borderColor: "var(--color-border)", background: "var(--color-bg-secondary)" }}>
        <p className="mb-3 text-xs" style={{ color: "var(--color-text-tertiary)" }}>
          Dépose juste un <strong style={{ color: "var(--color-text-secondary)" }}>screenshot de l'exo</strong> — l'IA comprend tout, pas besoin d'expliquer. Ou écris simplement une note (ex. « j'ai du mal avec le code où il y a des fork / pthread »). Le sujet est optionnel, l'IA le déduit.
        </p>
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Sujet (optionnel — l'IA le déduit du screenshot)"
          className="mb-3 w-full rounded-md border px-3 py-2 text-sm outline-none"
          style={{ background: "var(--color-bg-tertiary)", borderColor: "var(--color-border)", color: "var(--color-text-primary)" }}
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optionnel : ce que tu n'as pas compris…"
          rows={3}
          className="mb-3 w-full resize-y rounded-md border px-3 py-2 text-sm outline-none"
          style={{ background: "var(--color-bg-tertiary)", borderColor: "var(--color-border)", color: "var(--color-text-primary)" }}
        />
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="flex gap-1">
            {SEV.map((s) => (
              <button
                key={s.v}
                type="button"
                onClick={() => setSeverity(s.v)}
                className="rounded-md border px-2.5 py-1 text-xs"
                style={{
                  borderColor: severity === s.v ? s.color : "var(--color-border)",
                  color: severity === s.v ? s.color : "var(--color-text-secondary)",
                  background: "transparent",
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
          <label className="cursor-pointer text-xs" style={{ color: "var(--color-text-secondary)" }}>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
            <span className="rounded-md border px-2.5 py-1" style={{ borderColor: "var(--color-border)" }}>
              📎 screenshot
            </span>
          </label>
          <span className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
            …ou colle une image (Cmd+V)
          </span>
        </div>
        {preview && (
          <img src={preview} alt="aperçu" className="mb-3 max-h-40 rounded-md border" style={{ borderColor: "var(--color-border)" }} />
        )}
        <button
          type="submit"
          disabled={saving || !canSubmit}
          className="rounded-md px-4 py-2 text-sm font-medium disabled:opacity-40"
          style={{ background: "var(--color-accent)", color: "#1f1e1d" }}
        >
          {saving ? "Enregistrement…" : "Ajouter la faiblesse"}
        </button>
        {err && <p className="mt-2 text-xs" style={{ color: "#d9774f" }}>{err}</p>}
      </form>

      {/* Bandeau : faiblesses à analyser par l'IA */}
      {list.some((w) => !w.analyzed) && (
        <div className="mb-5 rounded-md border px-4 py-3 text-xs" style={{ borderColor: "var(--color-accent)", background: "var(--color-bg-secondary)", color: "var(--color-text-secondary)" }}>
          <strong style={{ color: "var(--color-accent)" }}>{list.filter((w) => !w.analyzed).length} faiblesse(s) à analyser.</strong>{" "}
          Dis à Claude Code « <em>analyse mes faiblesses</em> » (gratuit, via ton Max) — il lit tes screenshots et remplit tout. Ou clique ✦ sur une carte (utilise l'API, payant).
        </div>
      )}

      {/* Liste */}
      <div className="space-y-4">
        {list.length === 0 && (
          <p className="text-sm" style={{ color: "var(--color-text-tertiary)" }}>
            Aucune faiblesse pour l'instant. Ajoute un exo raté ci-dessus.
          </p>
        )}
        {list.map((w) => {
          const sev = SEV.find((s) => s.v === w.severity) ?? SEV[1];
          return (
            <div key={w.id} className="rounded-lg border p-4" style={{ borderColor: "var(--color-border)", background: "var(--color-bg-secondary)" }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: sev.color }} />
                  <h3 className="text-sm font-semibold" style={{ color: "var(--color-text-primary)" }}>{w.topic}</h3>
                  {!w.analyzed && (
                    <span className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide" style={{ border: "1px solid var(--color-accent)", color: "var(--color-accent)" }}>
                      à analyser
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button onClick={() => analyze(w.id)} disabled={analyzing === w.id} className="text-xs disabled:opacity-40" style={{ color: "var(--color-accent-soft)" }}>
                    {analyzing === w.id ? "analyse…" : "✦ analyser"}
                  </button>
                  <button onClick={() => remove(w.id)} className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>suppr</button>
                </div>
              </div>
              {w.screenshotUrl && (
                <img src={w.screenshotUrl} alt="" className="mt-3 max-h-56 rounded-md border" style={{ borderColor: "var(--color-border)" }} />
              )}
              {w.description && (
                <p className="mt-3 whitespace-pre-wrap text-xs leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>{w.description}</p>
              )}
              {w.related.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>À revoir dans ton corpus</div>
                  <ul className="flex flex-wrap gap-1.5">
                    {w.related.map((r) => (
                      <li key={r.itemId}>
                        <a href={r.href} target="_blank" rel="noopener" className="inline-block rounded-md border px-2 py-0.5 text-[11px]" style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
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
