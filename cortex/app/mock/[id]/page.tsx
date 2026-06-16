"use client";

import { use, useCallback, useEffect, useState } from "react";

type Item = { id: number; idx: number; topic: string; type: "scq" | "mcq"; stem: string; options: string[]; verified: number | null };
type Exam = { id: number; verifySummary: string | null; items: Item[] };
type Detail = { idx: number; correct: number[]; chosen: number[]; ok: boolean; explanation: string; misconceptions: string[] };
type Graded = { score: number; total: number; detail: Detail[] };

const LETTER = "ABCDEFGH".split("");

export default function MockPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [exam, setExam] = useState<Exam | null>(null);
  const [answers, setAnswers] = useState<Record<number, number[]>>({});
  const [graded, setGraded] = useState<Graded | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { (async () => {
    try { const d = await (await fetch(`/api/qcm/${id}`)).json(); if (d.error) setErr(d.error); else setExam(d); } catch { setErr("Chargement impossible."); }
  })(); }, [id]);

  const toggle = useCallback((it: Item, k: number) => {
    if (graded) return;
    setAnswers((a) => {
      const cur = a[it.idx] ?? [];
      if (it.type === "scq") return { ...a, [it.idx]: [k] };
      return { ...a, [it.idx]: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k] };
    });
  }, [graded]);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const d = await (await fetch(`/api/qcm/${id}/grade`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers }) })).json();
      if (d.error) setErr(d.error); else { setGraded(d); window.scrollTo({ top: 0, behavior: "smooth" }); }
    } catch { setErr("Correction impossible."); } finally { setBusy(false); }
  }

  const detailFor = (idx: number) => graded?.detail.find((d) => d.idx === idx);

  if (err) return <main className="page page-narrow"><div className="card card-pad" style={{ color: "var(--red)" }}>{err}</div></main>;
  if (!exam) return <main className="page page-narrow"><div className="skeleton" style={{ height: 200 }} /></main>;

  return (
    <main className="page page-narrow">
      <header className="mb-6 rise">
        <p className="eyebrow">Mock examen · QCM</p>
        <h1 className="h1 mt-2" style={{ fontSize: 28 }}>Examen blanc #{exam.id}</h1>
        <p className="sub mt-2">{exam.items.length} questions à choix · réponds, puis corrige-toi. SCQ = une seule case ; MCQ = une ou plusieurs.</p>
      </header>

      {graded && (
        <div className="card card-pad mb-6 rise" style={{ borderColor: "var(--accent-line)", boxShadow: "var(--shadow-accent)" }}>
          <div className="flex items-center gap-4">
            <div className="ring" style={{ ["--val" as any]: Math.round((graded.score / graded.total) * 100), ["--c" as any]: "var(--accent)" }}><span>{Math.round((graded.score / graded.total) * 100)}%</span></div>
            <div>
              <div className="stat-value">{graded.score} / {graded.total}</div>
              <div className="stat-label">QCM corrects · la correction détaille chaque idée fausse ci-dessous</div>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {exam.items.map((it) => {
          const det = detailFor(it.idx);
          const chosen = answers[it.idx] ?? [];
          return (
            <section key={it.id} className="card card-pad" style={det ? { borderColor: det.ok ? "var(--green)" : "var(--red)" } : undefined}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-[11.5px] uppercase tracking-wide" style={{ color: "var(--ink-3)" }}>Q{it.idx + 1} · {it.topic} · <span style={{ color: it.type === "mcq" ? "var(--blue-ink)" : "var(--accent-ink)" }}>{it.type.toUpperCase()}</span></span>
                {det && <span className={`tag ${det.ok ? "tag-green" : "tag-red"}`}>{det.ok ? "juste ✓" : "faux"}</span>}
              </div>
              <div className="text-[14.5px] mb-3" style={{ color: "var(--ink)", whiteSpace: "pre-wrap" }}>{it.stem}</div>
              <div className="flex flex-col gap-1.5">
                {it.options.map((o, k) => {
                  const picked = chosen.includes(k);
                  const isCorrect = det?.correct.includes(k);
                  const wrongPick = det && picked && !isCorrect;
                  const bg = det ? (isCorrect ? "var(--green-wash)" : wrongPick ? "var(--red-wash)" : "var(--surface-inset)") : picked ? "var(--accent-wash)" : "var(--surface-inset)";
                  const bd = det ? (isCorrect ? "var(--green)" : wrongPick ? "var(--red)" : "var(--line)") : picked ? "var(--accent-line)" : "var(--line)";
                  return (
                    <button key={k} onClick={() => toggle(it, k)} disabled={!!graded} className="inset" style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 12px", textAlign: "left", background: bg, border: `1px solid ${bd}`, cursor: graded ? "default" : "pointer" }}>
                      <span style={{ width: 22, height: 22, flex: "none", borderRadius: it.type === "mcq" ? 6 : 999, border: `1.5px solid ${bd}`, display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700, color: "var(--ink-2)" }}>{LETTER[k]}</span>
                      <span style={{ fontSize: 13.5, color: "var(--ink)", flex: 1 }}>{o}</span>
                      {det && isCorrect && <span style={{ color: "var(--green-ink)", fontSize: 13 }}>✓</span>}
                      {det && wrongPick && it && (det.misconceptions[k] ? <span style={{ color: "var(--red-ink)", fontSize: 11.5, maxWidth: 220 }}>⚠ {det.misconceptions[k]}</span> : <span style={{ color: "var(--red-ink)" }}>✗</span>)}
                    </button>
                  );
                })}
              </div>
              {det && det.explanation && <p className="mt-3 text-[12.5px]" style={{ color: "var(--ink-2)" }}><strong style={{ color: "var(--ink)" }}>Pourquoi :</strong> {det.explanation}</p>}
            </section>
          );
        })}
      </div>

      {!graded ? (
        <div className="mt-6 flex items-center gap-3">
          <button className="btn btn-primary btn-lg" onClick={submit} disabled={busy || Object.keys(answers).length === 0}>{busy ? "Correction…" : "Corriger mon examen"}</button>
          <span className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>{Object.keys(answers).length}/{exam.items.length} répondues</span>
        </div>
      ) : (
        <div className="mt-6"><a href="/examens" className="btn btn-ghost">← retour aux examens</a></div>
      )}
    </main>
  );
}
