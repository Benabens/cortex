"use client";

import CmdHint from "@/app/components/CmdHint";
import { useCallback, useEffect, useRef, useState } from "react";

type Exam = {
  id: number; createdAt: string; status: string; questionCount: number;
  url: string | null; solutionsUrl: string | null; verifySummary: string | null;
};
type Job = {
  id: number; type: string; status: string; currentStep: string | null;
  resultId?: number | null;
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
  const [errCmd, setErrCmd] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [dryBusy, setDryBusy] = useState(false);
  const pollRef = useRef<any>(null);
  const openedRef = useRef(false);
  // mock chrono
  const [mock, setMock] = useState<{ examId: number; endsAt: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [finished, setFinished] = useState<number[]>([]);
  // V6 — cours au format QCM (ex. ML/CS-233) : mock QCM interactif
  const [format, setFormat] = useState<any>(null);
  const [qcmJob, setQcmJob] = useState<Job | null>(null);
  const qcmPoll = useRef<any>(null);
  const pollQcm = useCallback((id: number) => {
    clearInterval(qcmPoll.current);
    qcmPoll.current = setInterval(async () => {
      try {
        const j: Job = await (await fetch(`/api/jobs/${id}`)).json();
        setQcmJob(j);
        if (!ACTIVE.includes(j.status)) clearInterval(qcmPoll.current);
      } catch {}
    }, 2500);
  }, []);
  async function genQcm() {
    setErr(null);
    try {
      const r = await fetch("/api/qcm/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      const d = await r.json();
      if (!r.ok) { setErr(d.error ?? "Échec"); return; }
      if (d.jobId) { setQcmJob({ id: d.jobId, type: "qcm", status: "queued", currentStep: "Démarrage…", progress: 0, resultPath: null, error: null, log: [] } as any); pollQcm(d.jobId); }
    } catch (e: any) { setErr(String(e.message ?? e)); }
  }

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
      // V6 — format du cours + reprise d'un job QCM
      try { const f = await (await fetch("/api/qcm/generate")).json(); setFormat(f.format); } catch {}
      try {
        const d = await (await fetch("/api/jobs?type=qcm")).json();
        if (d.active && ACTIVE.includes(d.active.status)) { setQcmJob(d.active); pollQcm(d.active.id); }
        else { const last = (d.recent ?? []).find((j: any) => j.type === "qcm" && j.status === "done" && j.resultPath); if (last) setQcmJob(last); }
      } catch {}
    })();
    try {
      const m = JSON.parse(localStorage.getItem(MOCK_KEY) ?? "null");
      if (m?.endsAt > Date.now()) setMock(m);
    } catch {}
    return () => { clearInterval(pollRef.current); clearInterval(qcmPoll.current); };
  }, [load, poll, pollQcm]);

  useEffect(() => {
    if (!mock) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [mock]);

  async function generate() {
    setErr(null);
    setErrCmd(null);
    setNote(null);
    openedRef.current = false;
    try {
      const r = await fetch("/api/exams/generate", { method: "POST" });
      const d = await r.json();
      if (!r.ok) { setErr(d.error ?? "Échec"); setErrCmd(d.command ?? null); return; }
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
      <header className="mb-6 rise">
        <p className="eyebrow">Examens générés</p>
        <h1 className="h1 mt-2" style={{ fontSize: 28 }}>Un examen qui aurait pu tomber.</h1>
        <p className="sub mt-2">Final blanc complet au format EPFL — figures verrouillées, difficulté calibrée, vérifié exo par exo.</p>
      </header>

      {format?.has_mcq && (
        <section className="card card-pad mb-6 rise">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-[15px] font-semibold" style={{ color: "var(--ink)" }}>Mock examen — format détecté</h2>
            <span className="tag tag-blue">QCM + ouvert</span>
          </div>
          <p className="text-[13px] mb-1" style={{ color: "var(--ink-2)" }}>{format.format_summary}</p>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {(format.question_types ?? []).map((t: any, i: number) => (
              <span key={i} className="chip" style={{ cursor: "default" }}>{t.type.toUpperCase()} ×{t.approx_count} · {t.share_pct}%</span>
            ))}
          </div>
          {qcmJob && ACTIVE.includes(qcmJob.status) ? (
            <div>
              <div className="progress"><div className="progress-bar" style={{ width: `${qcmJob.progress}%` }} /></div>
              <div className="mt-2 text-[13px]" style={{ color: "var(--ink-2)" }}>{qcmJob.currentStep}</div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn btn-primary" onClick={genQcm}>✦ Générer un mock QCM</button>
              {qcmJob?.status === "done" && qcmJob.resultPath && <>
                <a className="btn btn-ghost" href={qcmJob.resultPath}>ouvrir le mock (site) →</a>
                {qcmJob.resultId && <a className="btn btn-quiet" style={{ color: "var(--blue)" }} href={`/exam/qcm-${qcmJob.resultId}.pdf?course=ml`} target="_blank" rel="noopener">PDF énoncé</a>}
                {qcmJob.resultId && <a className="btn btn-quiet" style={{ color: "var(--green)" }} href={`/exam/qcm-${qcmJob.resultId}-corrige.pdf?course=ml`} target="_blank" rel="noopener">PDF corrigé</a>}
              </>}
              <span className="text-[12px] w-full" style={{ color: "var(--ink-3)" }}>site interactif + PDF au look d'un vrai final · auto-corrigé · distracteurs = idées fausses</span>
            </div>
          )}
          {qcmJob?.status === "error" && <p className="mt-2 text-[12px]" style={{ color: "var(--red)" }}>Échec : {qcmJob.error}</p>}
        </section>
      )}

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
            <div className="progress">
              <div className="progress-bar" style={{ width: `${job!.progress}%` }} />
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
        {err && <p className="mt-2.5 text-[12px]" style={{ color: "var(--red)" }}>{err}<CmdHint cmd={errCmd} /></p>}
        {note && <p className="mt-2.5 text-[12px]" style={{ color: "var(--ink-3)" }}>{note}</p>}
      </div>

      {exams.length > 0 && <div className="section-head"><span className="section-title">Tes examens</span></div>}
      <div className="card rise" style={{ padding: 8 }}>
        {exams.length === 0 ? (
          <div className="empty">
            <div className="empty-ico">✦</div>
            <div className="empty-title">Aucun examen pour l'instant</div>
            <div className="empty-sub">Génère ton premier final blanc — il apparaîtra ici.</div>
          </div>
        ) : exams.map((e) => {
          const revealed = finished.includes(e.id) || !e.solutionsUrl;
          return (
            <div key={e.id} className="t-row" style={{ gridTemplateColumns: "auto 1fr auto" }}>
              <span className="icon-tile icon-tile-sm" style={{ fontSize: 14 }}>📄</span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold" style={{ color: "var(--ink)" }}>Examen #{e.id}</span>
                  {e.verifySummary && <span className="tag tag-green" title={e.verifySummary}>vérifié</span>}
                </div>
                <div className="text-[11.5px] mt-0.5" style={{ color: "var(--ink-3)" }}>{e.questionCount} questions · {e.createdAt}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {e.url && <>
                  <button onClick={() => startMock(e)} className="btn btn-ghost btn-sm" disabled={!!mock}>▶ Mock 3 h</button>
                  <a href={e.url} target="_blank" rel="noopener" className="btn btn-quiet btn-sm" style={{ color: "var(--blue)" }}>sujet</a>
                </>}
                {e.solutionsUrl && revealed && <a href={e.solutionsUrl} target="_blank" rel="noopener" className="btn btn-quiet btn-sm" style={{ color: "var(--green)" }}>corrigé</a>}
                {e.solutionsUrl && !revealed && <span className="text-[11px] px-2" style={{ color: "var(--ink-3)" }}>corrigé caché</span>}
                <button onClick={() => remove(e.id)} className="btn btn-quiet btn-sm" title="supprimer">✕</button>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
