"use client";

import styles from "@/app/secondary.module.css";
import { PageHeader } from "@/components/ui/PageHeader";
import { useEffect, useMemo, useState } from "react";
import { useApi, useCourse } from "@/lib/ux/api";
import { LoadError } from "@/components/ui/LoadError";
import { Segmented } from "@/components/ui/Segmented";
import { Toggle } from "@/components/ui/Toggle";
import { useTranslations } from "use-intl/react";
import { MathText } from "@/components/ui/MathText";

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
  const t = useTranslations("revisionPage");
  const { courseId, ready, course } = useCourse();
  const language = course?.language || undefined; // "" = langue pas encore détectée : pas de lang vide
  // Données via le crochet commun : il expose l'ERREUR et une reprise — avant,
  // un catch muet laissait l'écran en squelette pour toujours.
  const { data: loaded, loading: fetching, error, refetch } = useApi<Data>("/api/revision");
  // Au changement de cours, les données de l'ancien ne sont pas montrées le temps
  // du rechargement ; compte sans cours : rien à charger, état vide.
  const d = loaded && (!loaded.course || loaded.course === courseId) ? loaded : null;
  const loading = !ready || (!!courseId && (fetching || (!d && !error)));
  const [tab, setTab] = useState<"qcm" | "open" | "plan">("qcm");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [reveal, setReveal] = useState<Record<number, boolean>>({});
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [hideDone, setHideDone] = useState(false);


  // progression locale : coche « fait » par question, persiste entre sessions (localStorage, par cours)
  useEffect(() => {
    if (!d?.course) return;
    try {
      const raw = localStorage.getItem(`cortex:revision:done:${d.course}`);
      /* eslint-disable react-hooks/set-state-in-effect -- hydratation locale après montage, sans accès au stockage pendant le rendu */
      setDone(raw ? JSON.parse(raw) : {});
      setHideDone(localStorage.getItem(`cortex:revision:hideDone:${d.course}`) === "1");
      /* eslint-enable react-hooks/set-state-in-effect */
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
    <button type="button" onClick={() => toggleDone(k)} aria-pressed={!!done[k]} title={done[k] ? t("doneTitle") : t("todoTitle")}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", borderRadius: "var(--r-sm)", padding: "9px 12px", fontSize: 12, lineHeight: 1.4, border: `1px solid ${done[k] ? "var(--green)" : "var(--line-strong)"}`, color: done[k] ? "var(--green-ink)" : "var(--ink-3)", background: done[k] ? "var(--green-wash)" : "transparent" }}>
      <span style={{ width: 14, height: 14, borderRadius: 4, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, border: `1.5px solid ${done[k] ? "var(--green)" : "var(--ink-3)"}`, color: "var(--green-ink)" }}>{done[k] ? "✓" : ""}</span>
      {done[k] ? t("done") : t("todo")}
    </button>
  );

  const qcmGroups = useMemo(() => groupByTopic(d?.bank.qcm ?? []), [d]);
  const openGroups = useMemo(() => groupByTopic(d?.bank.open ?? []), [d]);
  const planGroups = useMemo(() => groupByTopic(d?.plan.questions ?? []), [d]);
  const totBank = (d?.bank.stats.qcm ?? 0) + (d?.bank.stats.open ?? 0);
  const doneTotal = Object.values(done).filter(Boolean).length;

  return (
    <div className={styles.page}>
      <PageHeader
        title={t("title")}
        description={t("description")}
      />

      {!loading && error && (
        <LoadError
          title={t("loadFailed")}
          hint={t("loadHint")}
          onRetry={refetch}
        />
      )}

      {loading && <div className="card card-pad rise"><div className="skeleton" style={{ height: 120 }} /></div>}

      {!loading && !error && totBank === 0 && (d?.plan.stats.qcm ?? 0) === 0 && (
        <div className="card card-pad empty">
          <div className="empty-title">{t("emptyTitle")}</div>
          <div className="empty-sub">{t("emptyHint")}</div>
        </div>
      )}

      {!loading && d && totBank > 0 && (
        <>
          {/* récap proportions par sujet (ordre du cours) */}
          <section className={styles.guide}>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <h2 className="text-[15px] font-semibold" style={{ color: "var(--ink)" }}>{t("coverage")}</h2>
              <span className="tag tag-blue">{t("types", { qcm: d.bank.stats.qcm, open: d.bank.stats.open })}</span>
            </div>
            <div className={styles.coverage}>
              {d.bank.stats.byTopic.map((topic) => {
                const tot = topic.qcm + topic.open; const pct = Math.round((tot / Math.max(1, totBank)) * 100);
                return (
                  <div key={topic.topic} className={styles.coverageRow}>
                    <span className="tag">{lr(topic.lectureRank)}</span>
                    <div className="min-w-0"><span className="text-ink-1" lang={language}>{topic.topic}</span><div className="mt-1 text-xs text-ink-3">{t("types", { qcm: topic.qcm, open: topic.open })}</div></div>
                    <span className="tabular-nums text-accent-hi">{t("percent", { value: pct })}</span>
                    <div className={styles.track} role="img" aria-label={t("percentLabel", { value: pct })}><div style={{ width: `${pct}%` }} /></div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* onglets */}
          <Segmented
            size="sm"
            className="mb-3"
            label={t("displayed")}
            options={[
              { value: "qcm", label: t("qcmBank"), count: d.bank.stats.qcm },
              { value: "open", label: t("openBank"), count: d.bank.stats.open },
              { value: "plan", label: t("generatedPlan"), count: d.plan.stats.qcm + d.plan.stats.open },
            ]}
            value={tab}
            onChange={setTab}
          />

          <div className={styles.toolbar}>
            <Toggle checked={hideDone} onChange={toggleHide} label={t("hideDone")} labelVisible />
            <span style={{ color: "var(--ink-4)" }}>·</span>
            <span>{t.rich("markedDone", { count: doneTotal, strong: (c) => <strong style={{ color: "var(--ink-2)" }}>{c}</strong> })}</span>
            {doneTotal > 0 && <button className="btn btn-quiet btn-sm" onClick={resetDone}>{t("reset")}</button>}
          </div>

          {tab !== "plan" && (qcmGroups.length || openGroups.length) ? (
            <div className="space-y-2">
              {(tab === "qcm" ? qcmGroups : openGroups).map((g) => {
                const key = `${tab}:${g.topic}`;
                return (
                  <div key={key} className={styles.questionGroup}>
                    <button className={styles.questionToggle} aria-expanded={!!open[key]} onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}>
                      <span className="tag" style={{ minWidth: 42, justifyContent: "center" }}>{lr(g.lectureRank)}</span>
                      <span className="font-medium" style={{ color: "var(--ink)" }} lang={language}>{g.topic}</span>
                      <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>{t("groupDone", { done: g.items.filter((x) => done[`${tab}-${x.id}`]).length, total: g.items.length, state: open[key] ? "▾" : "▸" })}</span>
                    </button>
                    {open[key] && (
                      <div className="px-4 pb-3 space-y-2">
                        {g.items.map((q) => {
                          const dk = `${tab}-${q.id}`;
                          if (hideDone && done[dk]) return null;
                          return (
                          <div key={q.id} className={styles.question} style={{ opacity: done[dk] ? 0.7 : 1, transition: "opacity .15s" }}>
                            <div className="flex items-center gap-2 flex-wrap text-[12px] mb-1">
                              {doneBtn(dk)}
                              <span className="tag tag-blue" lang={language}>{q.sourceExam?.replace(/_/g, " ").slice(0, 28)}{q.examYear ? ` ${q.examYear}` : ""}{q.examPage ? ` · p.${q.examPage}` : ""}</span>
                              {q.examHref && <a className="btn btn-quiet btn-sm" style={{ color: "var(--accent-ink)" }} href={q.examHref} target="_blank" rel="noopener">{t("openPdf")}</a>}
                            </div>
                            <div className="text-[13.5px]" style={{ color: "var(--ink)" }} lang={language}><MathText text={q.statement} /></div>
                            {q.options && <pre className="mt-1 text-[12.5px]" style={{ color: "var(--ink-2)", whiteSpace: "pre-wrap", fontFamily: "inherit" }} lang={language}><MathText text={q.options} /></pre>}
                            {q.officialAnswer && (
                              reveal[q.id]
                                ? <div className="mt-1.5 text-[13px]" style={{ color: "var(--green-ink)" }}><strong>{t("officialAnswer")}</strong> <span lang={language}><MathText text={q.officialAnswer} /></span></div>
                                : <button className="btn btn-quiet btn-sm mt-1" style={{ color: "var(--green-ink)" }} onClick={() => setReveal((r) => ({ ...r, [q.id]: true }))}>{t("reveal")}</button>
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
              ? <div className="card card-pad empty"><div className="empty-title">{t("planEmptyTitle")}</div><div className="empty-sub">{t("planEmptyHint")}</div></div>
              : <div className="space-y-2">
                {planGroups.map((g) => {
                  const key = `plan:${g.topic}`;
                  return (
                    <div key={key} className={styles.questionGroup}>
                      <button className={styles.questionToggle} aria-expanded={!!open[key]} onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}>
                        <span className="tag" style={{ minWidth: 42, justifyContent: "center" }}>{lr(g.lectureRank)}</span>
                        <span className="font-medium" style={{ color: "var(--ink)" }} lang={language}>{g.topic}</span>
                        <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>{t("planGroup", { done: g.items.filter((x) => done[`plan-${x.id}`]).length, total: g.items.length, qcm: g.items.filter((x) => x.kind === "qcm").length, state: open[key] ? "▾" : "▸" })}</span>
                      </button>
                      {open[key] && (
                        <div className="px-4 pb-3 space-y-2">
                          {g.items.map((q) => {
                            const dk = `plan-${q.id}`;
                            if (hideDone && done[dk]) return null;
                            return (
                            <div key={q.id} className={styles.question} style={{ opacity: done[dk] ? 0.7 : 1, transition: "opacity .15s" }}>
                              <div className="flex items-center gap-2 flex-wrap text-[12px] mb-1">
                                {doneBtn(dk)}
                                <span className={`tag ${q.kind === "qcm" ? "tag-blue" : "tag-amber"}`}>{q.kind === "qcm" ? t("qcmKind") : t("openKind")}</span>
                                {q.verifyMethod === "deterministic" && <span className="tag tag-green" title={t("provedTitle")}>{t("proved")}</span>}
                                {q.verified === 1 && q.verifyMethod !== "deterministic" && <span className="tag" title={t("verifiedTitle")}>{t("verified")}</span>}
                              </div>
                              <div className="text-[13.5px]" style={{ color: "var(--ink)" }} lang={language}><MathText text={q.statement} /></div>
                              {q.options && <pre className="mt-1 text-[12.5px]" style={{ color: "var(--ink-2)", whiteSpace: "pre-wrap", fontFamily: "inherit" }} lang={language}><MathText text={q.options} /></pre>}
                              {reveal[q.id]
                                ? <div className="mt-1.5 text-[13px]" style={{ color: "var(--green-ink)", whiteSpace: "pre-line" }}>{q.kind === "qcm" ? <><strong>{t("answer")}</strong> <span lang={language}>{q.correct}. <MathText text={q.explanation} /></span></> : <><strong>{t("solution")}</strong> <span lang={language}><MathText text={q.solution} /></span></>}</div>
                                : <button className="btn btn-quiet btn-sm mt-1" style={{ color: "var(--green-ink)" }} onClick={() => setReveal((r) => ({ ...r, [q.id]: true }))}>{t("reveal")}</button>}
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
    </div>
  );
}
