"use client";

import { useEffect, useMemo, useState } from "react";
import { useCourse } from "@/lib/ux/api";

type BQ = { id: number; topic: string; lectureRank: number | null; statement: string; options: string | null; officialAnswer: string | null; sourceExam: string; examYear: number | null; examPage: number | null; examHref: string | null };
type PQ = { id: number; kind: "qcm" | "open"; topic: string; lectureRank: number | null; statement: string; options: string | null; correct: string | null; explanation: string | null; solution: string | null; verified: number | null; verifyMethod: string | null };
type Data = {
  course: string; source: string;
  bank: { stats: { qcm: number; open: number; byTopic: { topic: string; lectureRank: number | null; qcm: number; open: number }[] }; qcm: BQ[]; open: BQ[] };
  plan: { stats: { qcm: number; open: number; topics: number }; questions: PQ[] };
};

const lr = (n: number | null) => (n && n < 99 ? `L${n}` : "—");

function groupByTopic<T extends { topic: string; lectureRank: number | null }>(arr: T[]) {
  const m = new Map<string, { topic: string; lectureRank: number | null; items: T[] }>();
  for (const q of arr) { const k = q.topic; if (!m.has(k)) m.set(k, { topic: k, lectureRank: q.lectureRank, items: [] }); m.get(k)!.items.push(q); }
  return [...m.values()].sort((a, b) => (a.lectureRank ?? 99) - (b.lectureRank ?? 99) || a.topic.localeCompare(b.topic));
}

export default function RevisionPage() {
  const { courseId, ready } = useCourse();
  const [loaded, setLoaded] = useState<Data | null>(null);
  const [fetching, setFetching] = useState(true);
  // Au changement de cours, les données de l'ancien ne sont pas montrées le temps
  // du rechargement ; compte sans cours : rien à charger, état vide.
  const d = loaded && (!loaded.course || loaded.course === courseId) ? loaded : null;
  const loading = !ready || (!!courseId && (fetching || !d));
  const [tab, setTab] = useState<"qcm" | "open" | "plan">("qcm");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [reveal, setReveal] = useState<Record<number, boolean>>({});
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [hideDone, setHideDone] = useState(false);

  // Le cours est explicite : sans lui, l'API retombait sur cs-202, que seul son propriétaire peut lire.
  useEffect(() => {
    if (!ready) return;
    if (!courseId) return;
    let cancelled = false;
    (async () => {
      try {
        const next = (await (await fetch(`/api/revision?course=${encodeURIComponent(courseId)}`)).json()) as Data;
        if (!cancelled) setLoaded(next);
      } catch {}
      if (!cancelled) setFetching(false);
    })();
    return () => { cancelled = true; };
  }, [ready, courseId]);

  // progression locale : coche « fait » par question, persiste entre sessions (localStorage, par cours)
  useEffect(() => {
    if (!d?.course) return;
    try {
      const raw = localStorage.getItem(`cortex:revision:done:${d.course}`);
      setDone(raw ? JSON.parse(raw) : {});
      setHideDone(localStorage.getItem(`cortex:revision:hideDone:${d.course}`) === "1");
    } catch {}
  }, [d?.course]);
  const toggleDone = (k: string) => setDone((prev) => {
    const next: Record<string, boolean> = { ...prev, [k]: !prev[k] };
    if (!next[k]) delete next[k];
    try { localStorage.setItem(`cortex:revision:done:${d?.course}`, JSON.stringify(next)); } catch {}
    return next;
  });
  const toggleHide = () => setHideDone((v) => {
    const nv = !v;
    try { localStorage.setItem(`cortex:revision:hideDone:${d?.course}`, nv ? "1" : "0"); } catch {}
    return nv;
  });
  const resetDone = () => { setDone({}); try { localStorage.removeItem(`cortex:revision:done:${d?.course}`); } catch {} };
  const doneBtn = (k: string) => (
    <button type="button" onClick={() => toggleDone(k)} aria-pressed={!!done[k]} title={done[k] ? "fait — cliquer pour annuler" : "marquer comme fait"}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", borderRadius: "var(--r-sm)", padding: "3px 9px", fontSize: 12, lineHeight: 1.4, border: `1px solid ${done[k] ? "var(--green)" : "var(--line-strong)"}`, color: done[k] ? "var(--green-ink)" : "var(--ink-3)", background: done[k] ? "var(--green-wash)" : "transparent" }}>
      <span style={{ width: 14, height: 14, borderRadius: 4, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, border: `1.5px solid ${done[k] ? "var(--green)" : "var(--ink-3)"}`, color: "var(--green-ink)" }}>{done[k] ? "✓" : ""}</span>
      {done[k] ? "fait" : "à faire"}
    </button>
  );

  const qcmGroups = useMemo(() => groupByTopic(d?.bank.qcm ?? []), [d]);
  const openGroups = useMemo(() => groupByTopic(d?.bank.open ?? []), [d]);
  const planGroups = useMemo(() => groupByTopic(d?.plan.questions ?? []), [d]);
  const totBank = (d?.bank.stats.qcm ?? 0) + (d?.bank.stats.open ?? 0);
  const doneTotal = Object.values(done).filter(Boolean).length;

  return (
    <main className="page">
      <header className="mb-6 rise">
        <p className="eyebrow">Révision · {d?.course?.toUpperCase() ?? "ML"}</p>
        <h1 className="h1 mt-2" style={{ fontSize: 28 }}>Toutes les vraies questions des finals + un parcours qui couvre tout.</h1>
        <p className="sub mt-2">La banque exhaustive de chaque QCM et chaque ouverte des annales — triée par sujet, dans l'ordre du cours — et un parcours généré couvrant 100 % du programme à la bonne proportion. Déjà prêt, rien à relancer.</p>
      </header>

      {loading && <div className="card card-pad rise"><div className="skeleton" style={{ height: 120 }} /></div>}

      {!loading && totBank === 0 && (d?.plan.stats.qcm ?? 0) === 0 && (
        <div className="card card-pad empty">
          <div className="empty-ico">📚</div>
          <div className="empty-title">Banque pas encore construite</div>
          <div className="empty-sub">Lance <code className="kbd">npm run revision -- --course={d?.course ?? "ml"}</code> (index + parcours), puis recharge.</div>
        </div>
      )}

      {!loading && d && totBank > 0 && (
        <>
          {/* récap proportions par sujet (ordre du cours) */}
          <section className="card card-pad mb-5 rise">
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-[15px] font-semibold" style={{ color: "var(--ink)" }}>Couverture des finals — par sujet (ordre du cours)</h2>
              <span className="tag tag-blue">{d.bank.stats.qcm} QCM · {d.bank.stats.open} ouvertes</span>
              {d.source === "json" && <span className="tag" title="chargé depuis le fichier committé">pré-construit ✓</span>}
            </div>
            <div className="space-y-1.5">
              {d.bank.stats.byTopic.map((t) => {
                const tot = t.qcm + t.open; const pct = Math.round((tot / Math.max(1, totBank)) * 100);
                return (
                  <div key={t.topic} className="flex items-center gap-3 text-[13px]">
                    <span className="tag" style={{ minWidth: 42, justifyContent: "center" }}>{lr(t.lectureRank)}</span>
                    <span style={{ flex: 1, color: "var(--ink)" }}>{t.topic}</span>
                    <span style={{ color: "var(--ink-3)" }}>{t.qcm} QCM · {t.open} ouv.</span>
                    <div className="progress" style={{ width: 120 }}><div className="progress-bar" style={{ width: `${Math.min(100, pct * 3)}%`, background: "var(--blue)" }} /></div>
                    <span className="tabular-nums" style={{ color: "var(--accent-ink)", minWidth: 34, textAlign: "right" }}>{pct}%</span>
                  </div>
                );
              })}
            </div>
          </section>

          {/* onglets */}
          <div className="segmented mb-3">
            <button data-active={tab === "qcm"} onClick={() => setTab("qcm")}>Banque QCM ({d.bank.stats.qcm})</button>
            <button data-active={tab === "open"} onClick={() => setTab("open")}>Banque ouvertes ({d.bank.stats.open})</button>
            <button data-active={tab === "plan"} onClick={() => setTab("plan")}>Parcours généré ({(d.plan.stats.qcm) + (d.plan.stats.open)})</button>
          </div>

          <div className="flex items-center gap-3 mb-4 text-[12.5px] flex-wrap" style={{ color: "var(--ink-3)" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
              <input type="checkbox" checked={hideDone} onChange={toggleHide} style={{ accentColor: "var(--green)", width: 14, height: 14 }} />
              Masquer les questions faites
            </label>
            <span style={{ color: "var(--ink-4)" }}>·</span>
            <span><strong style={{ color: "var(--ink-2)" }}>{doneTotal}</strong> question{doneTotal > 1 ? "s" : ""} marquée{doneTotal > 1 ? "s" : ""} faite{doneTotal > 1 ? "s" : ""}</span>
            {doneTotal > 0 && <button className="btn btn-quiet btn-sm" onClick={resetDone}>réinitialiser</button>}
          </div>

          {tab !== "plan" && (qcmGroups.length || openGroups.length) ? (
            <div className="space-y-2">
              {(tab === "qcm" ? qcmGroups : openGroups).map((g) => {
                const key = `${tab}:${g.topic}`;
                return (
                  <div key={key} className="card" style={{ padding: 0 }}>
                    <button className="t-row w-full text-left" style={{ gridTemplateColumns: "auto 1fr auto", width: "100%" }} onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}>
                      <span className="tag" style={{ minWidth: 42, justifyContent: "center" }}>{lr(g.lectureRank)}</span>
                      <span className="font-medium" style={{ color: "var(--ink)" }}>{g.topic}</span>
                      <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>{g.items.filter((x) => done[`${tab}-${x.id}`]).length}/{g.items.length} faites · {open[key] ? "▾" : "▸"}</span>
                    </button>
                    {open[key] && (
                      <div className="px-4 pb-3 space-y-2">
                        {g.items.map((q) => {
                          const dk = `${tab}-${q.id}`;
                          if (hideDone && done[dk]) return null;
                          return (
                          <div key={q.id} className="inset" style={{ padding: 12, opacity: done[dk] ? 0.55 : 1, transition: "opacity .15s" }}>
                            <div className="flex items-center gap-2 flex-wrap text-[12px] mb-1">
                              {doneBtn(dk)}
                              <span className="tag tag-blue">{q.sourceExam?.replace(/_/g, " ").slice(0, 28)}{q.examYear ? ` ${q.examYear}` : ""}{q.examPage ? ` · p.${q.examPage}` : ""}</span>
                              {q.examHref && <a className="btn btn-quiet btn-sm" style={{ color: "var(--accent-ink)" }} href={q.examHref} target="_blank" rel="noopener">ouvrir (PDF) →</a>}
                            </div>
                            <div className="text-[13.5px]" style={{ color: "var(--ink)" }}>{q.statement}</div>
                            {q.options && <pre className="mt-1 text-[12.5px]" style={{ color: "var(--ink-2)", whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{q.options}</pre>}
                            {q.officialAnswer && (
                              reveal[q.id]
                                ? <div className="mt-1.5 text-[13px]" style={{ color: "var(--green-ink)" }}><strong>Réponse officielle :</strong> {q.officialAnswer}</div>
                                : <button className="btn btn-quiet btn-sm mt-1" style={{ color: "var(--green)" }} onClick={() => setReveal((r) => ({ ...r, [q.id]: true }))}>révéler la réponse</button>
                            )}
                          </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}

          {tab === "plan" && (
            (d.plan.questions.length === 0)
              ? <div className="card card-pad empty"><div className="empty-title">Parcours pas encore généré</div><div className="empty-sub">Lance <code className="kbd">npm run revision -- --course={d.course} --parcours</code>.</div></div>
              : <div className="space-y-2">
                {planGroups.map((g) => {
                  const key = `plan:${g.topic}`;
                  return (
                    <div key={key} className="card" style={{ padding: 0 }}>
                      <button className="t-row w-full text-left" style={{ gridTemplateColumns: "auto 1fr auto", width: "100%" }} onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}>
                        <span className="tag" style={{ minWidth: 42, justifyContent: "center" }}>{lr(g.lectureRank)}</span>
                        <span className="font-medium" style={{ color: "var(--ink)" }}>{g.topic}</span>
                        <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>{g.items.filter((x) => done[`plan-${x.id}`]).length}/{g.items.length} faites · {g.items.filter((x) => x.kind === "qcm").length} QCM · {open[key] ? "▾" : "▸"}</span>
                      </button>
                      {open[key] && (
                        <div className="px-4 pb-3 space-y-2">
                          {g.items.map((q) => {
                            const dk = `plan-${q.id}`;
                            if (hideDone && done[dk]) return null;
                            return (
                            <div key={q.id} className="inset" style={{ padding: 12, opacity: done[dk] ? 0.55 : 1, transition: "opacity .15s" }}>
                              <div className="flex items-center gap-2 flex-wrap text-[12px] mb-1">
                                {doneBtn(dk)}
                                <span className={`tag ${q.kind === "qcm" ? "tag-blue" : "tag-amber"}`}>{q.kind === "qcm" ? "QCM" : "ouverte"}</span>
                                {q.verifyMethod === "deterministic" && <span className="tag tag-green" title="réponse prouvée">✓ prouvé</span>}
                                {q.verified === 1 && q.verifyMethod !== "deterministic" && <span className="tag" title="vérifié (relecture)">vérifié</span>}
                              </div>
                              <div className="text-[13.5px]" style={{ color: "var(--ink)" }}>{q.statement}</div>
                              {q.options && <pre className="mt-1 text-[12.5px]" style={{ color: "var(--ink-2)", whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{q.options}</pre>}
                              {reveal[q.id]
                                ? <div className="mt-1.5 text-[13px]" style={{ color: "var(--green-ink)" }}>{q.kind === "qcm" ? <><strong>Réponse :</strong> {q.correct} — {q.explanation}</> : <><strong>Corrigé :</strong> {q.solution}</>}</div>
                                : <button className="btn btn-quiet btn-sm mt-1" style={{ color: "var(--green)" }} onClick={() => setReveal((r) => ({ ...r, [q.id]: true }))}>révéler</button>}
                            </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
          )}
        </>
      )}
    </main>
  );
}
