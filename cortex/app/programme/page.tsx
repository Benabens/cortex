"use client";

import CmdHint from "@/app/components/CmdHint";
import { useCallback, useEffect, useRef, useState } from "react";

const ACTIVE = ["queued", "running", "verifying", "compiling"];

type TopicView = {
  id: number;
  label: string;
  method: string | null;
  category: string | null;
  archetype: string | null;
  examWeight: number;
  examCount: number;
  source: string | null;
  description: string | null;
  mastery: number | null;
  attempts: number;
  lastScore: number | null;
  dueAt: string | null;
  status: "never" | "due" | "ok";
};
type Stats = { total: number; covered: number; mastered: number; due: number; coveragePct: number; masteryPct: number };
type Overview = { topics: TopicView[]; stats: Stats; next: TopicView | null; coverNext: TopicView | null };

const STATUS: Record<TopicView["status"], { label: string; color: string }> = {
  never: { label: "jamais vu", color: "var(--ink-3)" },
  due: { label: "à revoir", color: "var(--accent-ink)" },
  ok: { label: "à jour", color: "var(--green)" },
};

function masteryColor(m: number | null): string {
  if (m == null) return "var(--ink-3)";
  if (m < 4) return "var(--red)";
  if (m < 7) return "var(--accent-ink)";
  return "var(--green)";
}

export default function ProgrammePage() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);

  // ---- analyse de blueprint ----
  const [anaJob, setAnaJob] = useState<any>(null);
  const anaPoll = useRef<any>(null);
  const [anaErr, setAnaErr] = useState<string | null>(null);
  const [anaCmd, setAnaCmd] = useState<string | null>(null);

  // ---- entraînement (un exo à la fois, attribué à un type) ----
  const [trainTopic, setTrainTopic] = useState<TopicView | null>(null);
  const [exoJob, setExoJob] = useState<any>(null);
  const exoPoll = useRef<any>(null);
  const [exoErr, setExoErr] = useState<string | null>(null);
  const [exoCmd, setExoCmd] = useState<string | null>(null);
  const [scored, setScored] = useState<{ topic: TopicView; nextDue: string | null } | null>(null);

  const loadOverview = useCallback(async () => {
    try {
      const d = await (await fetch("/api/program")).json();
      setOv(d);
      return d as Overview;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const topicById = useCallback((id?: number) => ov?.topics.find((t) => t.id === id) ?? null, [ov]);

  const pollExo = useCallback((id: number, topic: TopicView | null) => {
    clearInterval(exoPoll.current);
    setScored(null);
    exoPoll.current = setInterval(async () => {
      try {
        const j = await (await fetch(`/api/jobs/${id}`)).json();
        setExoJob(j);
        if (!ACTIVE.includes(j.status)) {
          clearInterval(exoPoll.current);
          if (topic) setTrainTopic(topic);
        }
      } catch {}
    }, 2000);
  }, []);

  const pollAna = useCallback((id: number) => {
    clearInterval(anaPoll.current);
    anaPoll.current = setInterval(async () => {
      try {
        const j = await (await fetch(`/api/jobs/${id}`)).json();
        setAnaJob(j);
        if (!ACTIVE.includes(j.status)) {
          clearInterval(anaPoll.current);
          await loadOverview();
        }
      } catch {}
    }, 2500);
  }, [loadOverview]);

  // montage : overview + reprise des jobs actifs (blueprint / exo)
  useEffect(() => {
    (async () => {
      const d = await loadOverview();
      try {
        const a = await (await fetch("/api/program/analyze")).json();
        if (a.active && ACTIVE.includes(a.active.status)) { setAnaJob(a.active); pollAna(a.active.id); }
      } catch {}
      try {
        const e = await (await fetch("/api/jobs?type=exercise")).json();
        if (e.active) {
          let tid: number | undefined;
          try { tid = JSON.parse(e.active.target ?? "{}")?.topicId; } catch {}
          const topic = (d?.topics ?? []).find((t) => t.id === tid) ?? null;
          setExoJob(e.active);
          if (topic) setTrainTopic(topic);
          if (ACTIVE.includes(e.active.status)) pollExo(e.active.id, topic);
        }
      } catch {}
    })();
    return () => { clearInterval(exoPoll.current); clearInterval(anaPoll.current); };
  }, [loadOverview, pollAna, pollExo]);

  async function analyze() {
    setAnaErr(null); setAnaCmd(null);
    try {
      const r = await fetch("/api/program/analyze", { method: "POST" });
      const d = await r.json();
      if (!r.ok) { setAnaErr(d.error ?? "Échec"); setAnaCmd(d.command ?? null); return; }
      if (d.jobId) { setAnaJob({ id: d.jobId, status: "queued", progress: 0, currentStep: "Démarrage…" }); pollAna(d.jobId); }
    } catch (e: any) { setAnaErr(String(e.message ?? e)); }
  }

  async function train(topic: TopicView) {
    setExoErr(null); setExoCmd(null); setScored(null); setExoJob(null);
    setTrainTopic(topic);
    try {
      const r = await fetch("/api/program/train", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topicId: topic.id }) });
      const d = await r.json();
      if (!r.ok) { setExoErr(d.error ?? "Échec"); setExoCmd(d.command ?? null); return; }
      if (d.jobId) { setExoJob({ id: d.jobId, status: "queued", progress: 0, currentStep: "Démarrage…", resultPath: null }); pollExo(d.jobId, topic); }
    } catch (e: any) { setExoErr(String(e.message ?? e)); }
  }

  async function cancelExo() {
    if (!exoJob) return;
    clearInterval(exoPoll.current);
    try { await fetch(`/api/jobs/${exoJob.id}/cancel`, { method: "POST" }); } catch {}
    setExoJob(null);
  }

  async function score(topic: TopicView, value: number) {
    try {
      const r = await fetch("/api/program/score", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ topicId: topic.id, score: value, examId: exoJob?.resultId }),
      });
      const d = await r.json();
      if (!r.ok) { setExoErr(d.error ?? "Échec"); return; }
      setScored({ topic: d.topic, nextDue: d.topic?.dueAt ?? null });
      setExoJob(null);
      setTrainTopic(null);
      await loadOverview();
    } catch (e: any) { setExoErr(String(e.message ?? e)); }
  }

  const analyzing = anaJob && ACTIVE.includes(anaJob.status);
  const exoActive = exoJob && ACTIVE.includes(exoJob.status);
  const stats = ov?.stats;
  const empty = !loading && (ov?.topics.length ?? 0) === 0;

  return (
    <main className="page">
      <header className="mb-6">
        <p className="eyebrow">Programme &amp; Maîtrise</p>
        <h1 className="h1 mt-2" style={{ fontSize: 28 }}>Couvre tout le programme — au bon moment.</h1>
        <p className="text-[14px] mt-2" style={{ color: "var(--ink-2)", maxWidth: 680 }}>
          Cortex lit les vrais finals et en déduit les <strong style={{ color: "var(--ink)" }}>types d'exos</strong> et leur <strong style={{ color: "var(--ink)" }}>poids</strong>. Tu t'entraînes, tu te notes 0-10, et la <strong style={{ color: "var(--ink)" }}>courbe de l'oubli</strong> te re-propose un exo NEUF sur tes faiblesses au bon moment.
        </p>
      </header>

      {/* ---------- état vide : analyser le programme ---------- */}
      {empty && (
        <section className="card card-pad mb-8">
          <h2 className="text-[15px] font-semibold mb-1" style={{ color: "var(--ink)" }}>Dresser la carte de la matière</h2>
          <p className="text-[13px] mb-3" style={{ color: "var(--ink-2)" }}>
            Une passe IA (ton Max) classe chaque exercice des vrais finals en un type/méthode et en compte la fréquence → une taxonomie typée &amp; pondérée. Ingère d'abord le cours (cours + séries + finals).
          </p>
          {analyzing ? (
            <Progress job={anaJob} />
          ) : (
            <button className="btn btn-primary" onClick={analyze}>✦ Analyser le programme</button>
          )}
          {anaErr && <p className="mt-2 text-[12px]" style={{ color: "var(--red)" }}>{anaErr}<CmdHint cmd={anaCmd} /></p>}
        </section>
      )}

      {/* ---------- barres de progression globales ---------- */}
      {!empty && stats && (
        <section className="card card-pad mb-6">
          <div className="grid gap-5" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Meter label="Couverture du programme" sub={`${stats.covered}/${stats.total} types abordés`} pct={stats.coveragePct} color="var(--blue)" />
            <Meter label="Maîtrise (pondérée poids examen)" sub={`${stats.mastered}/${stats.total} types maîtrisés`} pct={stats.masteryPct} color="var(--green)" />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {ov?.coverNext && !exoActive && (
              <button className="btn btn-primary" onClick={() => train(ov.coverNext!)}>
                ▸ Parcours : travailler « {ov.coverNext.label.slice(0, 36)} »
              </button>
            )}
            {ov?.next && ov.next.id !== ov.coverNext?.id && !exoActive && (
              <button className="btn btn-ghost" onClick={() => train(ov.next!)}>recommandé : {ov.next.label.slice(0, 32)}</button>
            )}
            {!analyzing ? (
              <button className="btn btn-quiet" onClick={analyze}>↻ ré-analyser</button>
            ) : (
              <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>ré-analyse en cours…</span>
            )}
          </div>
          {analyzing && <div className="mt-3"><Progress job={anaJob} /></div>}
          {anaErr && <p className="mt-2 text-[12px]" style={{ color: "var(--red)" }}>{anaErr}<CmdHint cmd={anaCmd} /></p>}
        </section>
      )}

      {/* ---------- panneau d'entraînement actif ---------- */}
      {(exoActive || (exoJob && trainTopic) || scored) && (
        <section className="card card-pad mb-6" style={{ borderColor: "var(--accent)" }}>
          {trainTopic && (
            <div className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--accent-ink)" }}>
              Entraînement · {trainTopic.label}
            </div>
          )}
          {exoActive ? (
            <div>
              <Progress job={exoJob} />
              <div className="mt-2 flex items-center justify-between gap-3">
                <div className="text-[13px]" style={{ color: "var(--ink-2)" }}>{exoJob.currentStep}</div>
                <button className="btn btn-quiet" onClick={cancelExo}>annuler</button>
              </div>
            </div>
          ) : exoJob?.status === "done" && exoJob.resultPath && trainTopic ? (
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px]" style={{ color: "var(--green)" }}>Exercice prêt ✓</span>
                <a className="btn btn-ghost" href={exoJob.resultPath} target="_blank" rel="noopener">ouvrir l'énoncé (PDF)</a>
                <a className="btn btn-quiet" style={{ color: "var(--green)" }} href={exoJob.resultPath.replace(/(\.pdf)(\?|$)/, "-corrige$1$2")} target="_blank" rel="noopener">corrigé</a>
              </div>
              <div className="mt-4">
                <div className="text-[13px] mb-2" style={{ color: "var(--ink)" }}>Fais l'exo, corrige-toi, puis <strong>note ta maîtrise</strong> de 0 à 10 :</div>
                <div className="flex flex-wrap gap-1.5">
                  {Array.from({ length: 11 }, (_, i) => i).map((v) => (
                    <button key={v} className="btn btn-quiet" onClick={() => score(trainTopic, v)}
                      style={{ minWidth: 38, justifyContent: "center", borderColor: "var(--line)", color: masteryColor(v) }}>
                      {v}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[12px]" style={{ color: "var(--ink-3)" }}>0-3 → revient demain · 4-6 → revient vite · 7-10 → intervalle long (courbe de l'oubli).</p>
              </div>
            </div>
          ) : exoJob?.status === "error" ? (
            <p className="text-[12px]" style={{ color: "var(--red)" }}>Échec : {exoJob.error}</p>
          ) : null}
          {exoErr && <p className="mt-2 text-[12px]" style={{ color: "var(--red)" }}>{exoErr}<CmdHint cmd={exoCmd} /></p>}
        </section>
      )}

      {scored && (
        <section className="card card-pad mb-6">
          <div className="text-[13px]" style={{ color: "var(--ink)" }}>
            Noté ✓ « <strong>{scored.topic.label}</strong> » — maîtrise désormais{" "}
            <strong style={{ color: masteryColor(scored.topic.mastery) }}>{scored.topic.mastery ?? "—"}/10</strong>
            {scored.nextDue && <> · à revoir le <strong>{new Date(scored.nextDue).toLocaleDateString()}</strong></>}.
          </div>
        </section>
      )}

      {/* ---------- table par type ---------- */}
      {!empty && ov && (
        <section className="card card-pad">
          <h2 className="text-[15px] font-semibold mb-3" style={{ color: "var(--ink)" }}>Types d'exercices — par poids à l'examen</h2>
          <div className="space-y-1">
            {ov.topics.map((t) => (
              <div key={t.id} className="rounded-lg px-3 py-2.5" style={{ border: "1px solid var(--line)", background: "var(--surface)" }}>
                <div className="flex items-start gap-3">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[14px] font-medium" style={{ color: "var(--ink)" }}>{t.label}</span>
                      {t.category && <span className="badge" style={{ background: "transparent", border: "1px solid var(--line)", color: "var(--ink-3)" }}>{t.category}</span>}
                      <span className="badge" style={{ background: "transparent", border: `1px solid ${STATUS[t.status].color}`, color: STATUS[t.status].color }}>{STATUS[t.status].label}</span>
                    </div>
                    {t.method && <div className="text-[12px] mt-0.5" style={{ color: "var(--ink-2)" }}>{t.method}</div>}
                    <div className="mt-1.5 flex items-center gap-3 text-[12px]" style={{ color: "var(--ink-3)" }}>
                      <span title="poids à l'examen">⚖ {t.examWeight}%{t.examCount ? ` · ${t.examCount}× en final` : t.source !== "final" ? ` · ${t.source}` : ""}</span>
                      <span title="tentatives">▷ {t.attempts ? `${t.attempts} exo${t.attempts > 1 ? "s" : ""}` : "jamais fait"}</span>
                      {t.mastery != null && <span title="dernier score">dernier : {t.lastScore}/10</span>}
                    </div>
                    {/* barre de poids examen */}
                    <div className="progress mt-2" style={{ height: 4 }}>
                      <div className="progress-bar" style={{ width: `${Math.min(100, t.examWeight * 3)}%`, background: "var(--blue)" }} />
                    </div>
                  </div>
                  <div style={{ textAlign: "right", minWidth: 96 }}>
                    <div className="text-[20px] font-semibold" style={{ color: masteryColor(t.mastery) }}>
                      {t.mastery == null ? "—" : t.mastery}<span className="text-[12px]" style={{ color: "var(--ink-3)" }}>/10</span>
                    </div>
                    <button className="btn btn-ghost mt-1" style={{ fontSize: 12 }} disabled={exoActive} onClick={() => train(t)}>
                      M'entraîner
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function Meter({ label, sub, pct, color }: { label: string; sub: string; pct: number; color: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium" style={{ color: "var(--ink)" }}>{label}</span>
        <span className="text-[18px] font-semibold" style={{ color }}>{pct}%</span>
      </div>
      <div className="progress mt-1.5">
        <div className="progress-bar" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="text-[12px] mt-1" style={{ color: "var(--ink-3)" }}>{sub}</div>
    </div>
  );
}

function Progress({ job }: { job: any }) {
  return (
    <div>
      <div className="progress"><div className="progress-bar" style={{ width: `${job?.progress ?? 0}%` }} /></div>
      <div className="text-[13px] mt-2" style={{ color: "var(--ink-2)" }}>{job?.currentStep ?? "…"}</div>
    </div>
  );
}
