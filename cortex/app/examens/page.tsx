"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Exam = {
  id: number; createdAt: string; status: string; questionCount: number;
  url: string | null; solutionsUrl: string | null; verifySummary: string | null;
};
type Job = {
  id: number; type: string; status: string; currentStep: string | null;
  progress: number; resultPath: string | null; error: string | null;
  log: { t: string; msg: string }[];
};

const MOCK_KEY = "cortex-mock";
const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const ACTIVE = ["queued", "running", "verifying", "compiling"];

export default function ExamensPage() {
  const [exams, setExams] = useState<Exam[]>([]);
  const [sched, setSched] = useState<{ total: number; due: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [dryBusy, setDryBusy] = useState(false);
  const pollRef = useRef<any>(null);
  const openedRef = useRef(false);
  // mock chrono
  const [mock, setMock] = useState<{ examId: number; endsAt: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [finished, setFinished] = useState<number[]>([]);

  const load = useCallback(async () => {
    const d = await (await fetch("/api/exams")).json();
    setExams(d.exams ?? []);
    setSched(d.schedule ?? null);
  }, []);

  const poll = useCallback((id: number) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const j: Job = await (await fetch(`/api/jobs/${id}`)).json();
        setJob(j);
        if (!ACTIVE.includes(j.status)) {
          clearInterval(pollRef.current);
          if (j.status === "done") {
            await load();
            if (j.resultPath && !openedRef.current) { openedRef.current = true; window.open(j.resultPath, "_blank"); }
          }
        }
      } catch {}
    }, 2000);
  }, [load]);

  useEffect(() => {
    load();
    // reprise au reload : job examen actif ?
    (async () => {
      try {
        const d = await (await fetch("/api/jobs?type=exam")).json();
        if (d.active && ACTIVE.includes(d.active.status)) { setJob(d.active); openedRef.current = false; poll(d.active.id); }
      } catch {}
    })();
    try {
      const m = JSON.parse(localStorage.getItem(MOCK_KEY) ?? "null");
      if (m?.endsAt > Date.now()) setMock(m);
    } catch {}
    return () => clearInterval(pollRef.current);
  }, [load, poll]);

  useEffect(() => {
    if (!mock) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [mock]);

  async function generate() {
    setErr(null);
    setNote(null);
    openedRef.current = false;
    try {
      const r = await fetch("/api/exams/generate", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Échec");
      if (d.jobId) { setJob({ id: d.jobId, type: "exam", status: "queued", currentStep: "Démarrage…", progress: 0, resultPath: null, error: null, log: [] }); poll(d.jobId); }
    } catch (e: any) { setErr(String(e.message ?? e)); }
  }
  async function dryRun() {
    setDryBusy(true); setErr(null);
    try {
      const r = await fetch("/api/exams/generate?dry=1", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Échec");
      await load();
      if (d.url) window.open(d.url, "_blank");
    } catch (e: any) { setErr(String(e.message ?? e)); } finally { setDryBusy(false); }
  }
  async function cancel() {
    if (!job) return;
    clearInterval(pollRef.current);
    try { await fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" }); } catch {}
    setJob(null);
    setNote("Génération annulée — le worker a été arrêté.");
  }
  async function remove(id: number) { await fetch(`/api/exams?id=${id}`, { method: "DELETE" }); await load(); }

  function startMock(e: Exam) {
    const m = { examId: e.id, endsAt: Date.now() + 180 * 60_000 };
    setMock(m); localStorage.setItem(MOCK_KEY, JSON.stringify(m));
    if (e.url) window.open(e.url, "_blank");
  }
  function finishMock(examId: number) { setFinished((f) => [...f, examId]); setMock(null); localStorage.removeItem(MOCK_KEY); }

  const running = job && ACTIVE.includes(job.status);

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
            <div className="text-[26px] font-bold tabular-nums" style={{ color: mock.endsAt - now < 15 * 60_000 ? "var(--red)" : "var(--ink)" }}>{fmt(mock.endsAt - now)}</div>
            {mock.endsAt - now <= 0 && <div className="text-[12px]" style={{ color: "var(--red)" }}>Temps écoulé !</div>}
          </div>
          <button className="btn btn-primary" onClick={() => finishMock(mock.examId)}>Terminer → corrigé</button>
        </div>
      )}

      <div className="card card-pad mb-7">
        <p className="text-[14px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
          Examen inédit au format des vrais finals EPFL, vérifié exo par exo, généré via ton <strong style={{ color: "var(--ink)" }}>Max</strong>. La génération tourne <strong style={{ color: "var(--ink)" }}>en arrière-plan</strong> : tu peux recharger ou fermer l'onglet, elle continue.
        </p>
        {sched && <p className="mt-2.5 text-[13px]" style={{ color: "var(--ink-3)" }}>Répétition espacée : <strong style={{ color: "var(--accent-ink)" }}>{sched.due}</strong> concept(s) à revoir sur {sched.total}.</p>}

        {running ? (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[13px] font-medium" style={{ color: "var(--ink)" }}>Génération en cours…</span>
              <button className="btn btn-quiet" onClick={cancel}>annuler</button>
            </div>
            <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--surface-2)" }}>
              <div className="h-full transition-all" style={{ width: `${job!.progress}%`, background: "var(--accent)" }} />
            </div>
            <div className="mt-2 text-[13px]" style={{ color: "var(--ink-2)" }}>{job!.currentStep}</div>
            {job!.log.length > 0 && (
              <div className="mt-2 rounded-lg p-2 text-[11px] leading-relaxed max-h-32 overflow-auto" style={{ background: "var(--surface-2)", color: "var(--ink-3)" }}>
                {job!.log.slice(-8).map((l, i) => <div key={i}>{l.msg}</div>)}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button onClick={generate} className="btn btn-primary">✦ Générer un examen</button>
            <button onClick={dryRun} disabled={dryBusy} className="btn btn-quiet">{dryBusy ? "test…" : "tester le rendu (dry-run)"}</button>
          </div>
        )}
        {job?.status === "error" && <p className="mt-2.5 text-[12px]" style={{ color: "var(--red)" }}>Échec : {job.error}</p>}
        {err && <p className="mt-2.5 text-[12px]" style={{ color: "var(--red)" }}>{err}</p>}
        {note && <p className="mt-2.5 text-[12px]" style={{ color: "var(--ink-3)" }}>{note}</p>}
      </div>

      <div className="space-y-2.5">
        {exams.length === 0 && <p className="text-[14px]" style={{ color: "var(--ink-3)" }}>Aucun examen pour l'instant.</p>}
        {exams.map((e) => {
          const revealed = finished.includes(e.id) || !e.solutionsUrl;
          return (
            <div key={e.id} className="card" style={{ padding: "14px 18px" }}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-[14px] font-semibold" style={{ color: "var(--ink)" }}>Examen #{e.id}</span>
                  <span className="ml-2 text-[12px]" style={{ color: "var(--ink-3)" }}>{e.questionCount} question(s) · {e.createdAt}</span>
                  {e.verifySummary && <div className="text-[11px] mt-0.5" style={{ color: "var(--green)" }}>vérif : {e.verifySummary}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {e.url && <>
                    <button onClick={() => startMock(e)} className="btn btn-ghost" disabled={!!mock}>▶ Mock 3 h</button>
                    <a href={e.url} target="_blank" rel="noopener" className="btn btn-quiet" style={{ color: "var(--blue)" }}>sujet</a>
                  </>}
                  {e.solutionsUrl && revealed && <a href={e.solutionsUrl} target="_blank" rel="noopener" className="btn btn-quiet" style={{ color: "var(--green)" }}>corrigé</a>}
                  {e.solutionsUrl && !revealed && <span className="text-[11px] px-2" style={{ color: "var(--ink-3)" }}>corrigé caché</span>}
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
