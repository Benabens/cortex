"use client";

import { useCallback, useEffect, useState } from "react";

type Exam = {
  id: number;
  createdAt: string;
  status: string;
  questionCount: number;
  url: string | null;
  solutionsUrl: string | null;
  verifySummary: string | null;
};

const MOCK_KEY = "cortex-mock"; // { examId, endsAt } — persiste le chrono au refresh

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export default function ExamensPage() {
  const [exams, setExams] = useState<Exam[]>([]);
  const [sched, setSched] = useState<{ total: number; due: number } | null>(null);
  const [busy, setBusy] = useState<"" | "real" | "dry">("");
  const [err, setErr] = useState<string | null>(null);
  // mode mock chronométré
  const [mock, setMock] = useState<{ examId: number; endsAt: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [finished, setFinished] = useState<number[]>([]); // examens « terminés » (corrigé révélé)

  const load = useCallback(async () => {
    const d = await (await fetch("/api/exams")).json();
    setExams(d.exams ?? []);
    setSched(d.schedule ?? null);
  }, []);
  useEffect(() => {
    load();
    try {
      const m = JSON.parse(localStorage.getItem(MOCK_KEY) ?? "null");
      if (m?.endsAt > Date.now()) setMock(m);
    } catch {}
  }, [load]);

  // tick du chrono
  useEffect(() => {
    if (!mock) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [mock]);

  function startMock(e: Exam) {
    const m = { examId: e.id, endsAt: Date.now() + 180 * 60_000 };
    setMock(m);
    localStorage.setItem(MOCK_KEY, JSON.stringify(m));
    if (e.url) window.open(e.url, "_blank");
  }

  function finishMock(examId: number) {
    setFinished((f) => [...f, examId]);
    setMock(null);
    localStorage.removeItem(MOCK_KEY);
  }

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

      {mock && (
        <div className="card card-pad mb-5 flex items-center justify-between" style={{ borderColor: "var(--accent)" }}>
          <div>
            <div className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--accent-ink)" }}>Mock en cours — Examen #{mock.examId}</div>
            <div className="text-[26px] font-bold tabular-nums" style={{ color: mock.endsAt - now < 15 * 60_000 ? "var(--red)" : "var(--ink)" }}>
              {fmt(mock.endsAt - now)}
            </div>
            {mock.endsAt - now <= 0 && <div className="text-[12px]" style={{ color: "var(--red)" }}>Temps écoulé !</div>}
          </div>
          <button className="btn btn-primary" onClick={() => finishMock(mock.examId)}>Terminer → corrigé</button>
        </div>
      )}

      <div className="card card-pad mb-7">
        <p className="text-[14px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
          Un examen <strong style={{ color: "var(--ink)" }}>inédit</strong> au format des vrais finals EPFL, vérifié exo par exo, généré via ton <strong style={{ color: "var(--ink)" }}>Max</strong> (gratuit). Mode mock : le PDF s'ouvre <strong style={{ color: "var(--ink)" }}>sans corrigé</strong>, chrono 3 h, « Terminer » révèle le corrigé.
        </p>
        {sched && (
          <p className="mt-2.5 text-[13px]" style={{ color: "var(--ink-3)" }}>
            Répétition espacée : <strong style={{ color: "var(--accent-ink)" }}>{sched.due}</strong> concept(s) à revoir sur {sched.total}.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button onClick={() => generate(false)} disabled={busy !== ""} className="btn btn-primary">
            {busy === "real" ? "Génération + vérification… (~10-15 min)" : "✦ Générer un examen"}
          </button>
          <button onClick={() => generate(true)} disabled={busy !== ""} className="btn btn-quiet">
            {busy === "dry" ? "test…" : "tester le rendu (dry-run)"}
          </button>
        </div>
        {err && <p className="mt-2.5 text-[12px]" style={{ color: "var(--red)" }}>{err}</p>}
      </div>

      <div className="space-y-2.5">
        {exams.length === 0 && (
          <p className="text-[14px]" style={{ color: "var(--ink-3)" }}>Aucun examen pour l'instant.</p>
        )}
        {exams.map((e) => {
          const revealed = finished.includes(e.id) || !e.solutionsUrl; // pas de PDF corrigé séparé → lien direct
          return (
            <div key={e.id} className="card" style={{ padding: "14px 18px" }}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-[14px] font-semibold" style={{ color: "var(--ink)" }}>Examen #{e.id}</span>
                  <span className="ml-2 text-[12px]" style={{ color: "var(--ink-3)" }}>
                    {e.questionCount} question(s) · {e.createdAt}
                  </span>
                  {e.verifySummary && (
                    <div className="text-[11px] mt-0.5" style={{ color: "var(--green)" }}>vérif : {e.verifySummary}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {e.url && (
                    <>
                      <button onClick={() => startMock(e)} className="btn btn-ghost" disabled={!!mock}>▶ Mock 3 h</button>
                      <a href={e.url} target="_blank" rel="noopener" className="btn btn-quiet" style={{ color: "var(--blue)" }}>sujet</a>
                    </>
                  )}
                  {e.solutionsUrl && revealed && (
                    <a href={e.solutionsUrl} target="_blank" rel="noopener" className="btn btn-quiet" style={{ color: "var(--green)" }}>corrigé</a>
                  )}
                  {e.solutionsUrl && !revealed && (
                    <span className="text-[11px] px-2" style={{ color: "var(--ink-3)" }}>corrigé caché</span>
                  )}
                  <button onClick={() => remove(e.id)} className="btn btn-quiet">suppr</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
