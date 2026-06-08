"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Exam = { id: number; createdAt: string; status: string; questionCount: number; url: string | null };

export default function ExamensPage() {
  const [exams, setExams] = useState<Exam[]>([]);
  const [sched, setSched] = useState<{ total: number; due: number } | null>(null);
  const [busy, setBusy] = useState<"" | "real" | "dry">("");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = await (await fetch("/api/exams")).json();
    setExams(d.exams ?? []);
    setSched(d.schedule ?? null);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function generate(dry: boolean) {
    setBusy(dry ? "dry" : "real");
    setErr(null);
    try {
      const r = await fetch(`/api/exams/generate${dry ? "?dry=1" : ""}`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Échec");
      await load();
      if (d.url) window.open(d.url, "_blank");
    } catch (e: any) {
      const m = String(e.message ?? e);
      setErr(m.includes("ANTHROPIC_API_KEY") ? "Ajoute ta clé API dans cortex/.env.local pour générer un vrai examen (le dry-run marche sans clé)." : m);
    } finally {
      setBusy("");
    }
  }

  async function remove(id: number) {
    await fetch(`/api/exams?id=${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="mb-6 flex items-center gap-3 text-sm">
        <Link href="/" style={{ color: "var(--color-text-tertiary)" }}>← Cortex</Link>
        <span style={{ color: "var(--color-text-tertiary)" }}>/ Examens générés</span>
      </div>

      <div className="mb-6 rounded-lg border p-5" style={{ borderColor: "var(--color-border)", background: "var(--color-bg-secondary)" }}>
        <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
          Un examen <strong style={{ color: "var(--color-text-primary)" }}>inédit</strong>, généré à partir du cours, du format des anciens examens, de tes faiblesses et des concepts à revoir.
        </p>
        {sched && (
          <p className="mt-2 text-xs" style={{ color: "var(--color-text-tertiary)" }}>
            Répétition espacée : <strong style={{ color: "var(--color-accent)" }}>{sched.due}</strong> concept(s) à revoir sur {sched.total}.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={() => generate(false)}
            disabled={busy !== ""}
            className="rounded-md px-4 py-2 text-sm font-medium disabled:opacity-40"
            style={{ background: "var(--color-accent)", color: "#1f1e1d" }}
          >
            {busy === "real" ? "Génération… (peut prendre 1 min)" : "✦ Générer un examen"}
          </button>
          <button
            onClick={() => generate(true)}
            disabled={busy !== ""}
            className="text-xs disabled:opacity-40"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {busy === "dry" ? "test…" : "tester le rendu (dry-run, sans clé)"}
          </button>
        </div>
        {err && <p className="mt-2 text-xs" style={{ color: "#d9774f" }}>{err}</p>}
      </div>

      <div className="space-y-2">
        {exams.length === 0 && (
          <p className="text-sm" style={{ color: "var(--color-text-tertiary)" }}>Aucun examen pour l'instant.</p>
        )}
        {exams.map((e) => (
          <div key={e.id} className="flex items-center justify-between gap-3 rounded-md border px-4 py-3" style={{ borderColor: "var(--color-border)", background: "var(--color-bg-secondary)" }}>
            <div>
              <a href={e.url ?? "#"} target="_blank" rel="noopener" className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>
                Examen #{e.id}
              </a>
              <span className="ml-2 text-xs" style={{ color: "var(--color-text-tertiary)" }}>
                {e.questionCount} question(s) · {e.createdAt}
              </span>
            </div>
            <div className="flex items-center gap-3">
              {e.url && (
                <a href={e.url} target="_blank" rel="noopener" className="text-xs" style={{ color: "var(--color-accent-soft)" }}>ouvrir</a>
              )}
              <button onClick={() => remove(e.id)} className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>suppr</button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
