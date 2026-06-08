"use client";

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
      if (!r.ok) {
        if (r.status === 503) {
          throw new Error(
            "Claude Code (Max) n'est pas joignable ici. Lance l'app sur ta machine où `claude` est installé et connecté à ton Max, puis réessaie."
          );
        }
        throw new Error(d.error ?? "Échec");
      }
      await load();
      if (d.url) window.open(d.url, "_blank");
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setBusy("");
    }
  }

  async function remove(id: number) {
    await fetch(`/api/exams?id=${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <main className="page page-narrow">
      <header className="mb-6">
        <p className="eyebrow">Examens générés</p>
        <h1 className="h1 mt-2" style={{ fontSize: 28 }}>Un examen qui aurait pu tomber.</h1>
      </header>

      <div className="card card-pad mb-7">
        <p className="text-[14px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
          Un examen <strong style={{ color: "var(--ink)" }}>inédit</strong>, calqué sur le format des vrais examens EPFL récents (tes examens de référence), ciblé sur tes faiblesses et les concepts à revoir — prêt à imprimer en PDF. Généré via ton abonnement <strong style={{ color: "var(--ink)" }}>Max</strong> (gratuit).
        </p>
        {sched && (
          <p className="mt-2.5 text-[13px]" style={{ color: "var(--ink-3)" }}>
            Répétition espacée : <strong style={{ color: "var(--accent-ink)" }}>{sched.due}</strong> concept(s) à revoir sur {sched.total}.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button onClick={() => generate(false)} disabled={busy !== ""} className="btn btn-primary">
            {busy === "real" ? "Génération… (~1 min)" : "✦ Générer un examen"}
          </button>
          <button onClick={() => generate(true)} disabled={busy !== ""} className="btn btn-quiet">
            {busy === "dry" ? "test…" : "tester le rendu (dry-run, sans clé)"}
          </button>
        </div>
        {err && <p className="mt-2.5 text-[12px]" style={{ color: "var(--red)" }}>{err}</p>}
      </div>

      <div className="space-y-2.5">
        {exams.length === 0 && (
          <p className="text-[14px]" style={{ color: "var(--ink-3)" }}>Aucun examen pour l'instant.</p>
        )}
        {exams.map((e) => (
          <div key={e.id} className="card flex items-center justify-between gap-3" style={{ padding: "14px 18px" }}>
            <div>
              <a href={e.url ?? "#"} target="_blank" rel="noopener" className="text-[14px] font-semibold" style={{ color: "var(--ink)" }}>
                Examen #{e.id}
              </a>
              <span className="ml-2 text-[12px]" style={{ color: "var(--ink-3)" }}>
                {e.questionCount} question(s) · {e.createdAt}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {e.url && (
                <a href={e.url} target="_blank" rel="noopener" className="btn btn-quiet" style={{ color: "var(--blue)" }}>ouvrir</a>
              )}
              <button onClick={() => remove(e.id)} className="btn btn-quiet">suppr</button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
