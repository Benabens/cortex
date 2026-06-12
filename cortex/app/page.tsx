"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Dash = {
  course: { id: string; name: string; short: string; examCode: string; examKind: string };
  analyzed: boolean;
  stats: { total: number; covered: number; mastered: number; due: number; coveragePct: number; masteryPct: number };
  next: { id: number; label: string; category: string; examWeight: number; status: string; mastery: number | null } | null;
  cover: { id: number; label: string; examWeight: number } | null;
  schedule: { total: number; due: number };
  exams: { id: number; status: string; questionCount: number; verifySummary: string | null; url: string | null; solutionsUrl: string | null }[];
  weaknesses: { count: number; top: { id: number; topic: string; severity: number }[] };
  countdown: { date: string; days: number } | null;
  job: { id: number; type: string; status: string; progress: number; currentStep: string | null; resultPath: string | null } | null;
};

const CAT_COLOR: Record<string, string> = {
  Networking: "var(--blue)", OS: "var(--green)", C: "var(--violet)", Labs: "var(--accent)",
};

function Ring({ val, color, label }: { val: number; color: string; label: string }) {
  return (
    <div className="ring" style={{ ["--val" as any]: val, ["--c" as any]: color }}>
      <span>{val}%</span>
      <span className="sr-only">{label}</span>
    </div>
  );
}

export default function Home() {
  const [d, setD] = useState<Dash | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try { setD(await (await fetch("/api/dashboard")).json()); } catch {}
      setLoading(false);
    })();
  }, []);

  const actions = [
    { href: "/examens", icon: "✦", label: "Générer un examen", desc: "Final blanc complet", primary: true },
    { href: "/entrainement", icon: "🎯", label: "Drill un point faible", desc: "Question + indices" },
    { href: "/entrainement", icon: "🧪", label: "Exo Labs", desc: "Format Q6 2025" },
    { href: "/programme", icon: "📊", label: "Couvrir le programme", desc: "Au bon moment" },
  ];

  return (
    <main className="page page-wide">
      {/* ── En-tête ── */}
      <header className="rise" style={{ marginBottom: 28 }}>
        <p className="eyebrow">{d?.course.name ?? "Cortex"} · {d?.course.examCode ?? ""}</p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <h1 className="h1 text-gradient" style={{ maxWidth: 620 }}>
            {d?.analyzed ? "Voici où tu en es." : "Révise ce qui tombe vraiment."}
          </h1>
          {d?.countdown && d.countdown.days >= 0 && (
            <div className="card card-pad" style={{ padding: "12px 18px", display: "flex", alignItems: "center", gap: 14 }}>
              <div className="stat" style={{ alignItems: "center" }}>
                <div className="stat-value" style={{ color: d.countdown.days <= 7 ? "var(--accent-ink)" : "var(--ink)" }}>J−{d.countdown.days}</div>
                <div className="stat-label">avant l'examen</div>
              </div>
            </div>
          )}
        </div>
      </header>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 104 }} />)}
        </div>
      ) : (
        <>
          {/* ── Statistiques ── */}
          {d?.analyzed && (
            <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 rise rise-1" style={{ marginBottom: 28 }}>
              <div className="card card-pad flex items-center gap-4">
                <Ring val={d.stats.masteryPct} color="var(--accent)" label="maîtrise" />
                <div className="stat"><div className="stat-value">{d.stats.masteryPct}%</div><div className="stat-label">Maîtrise (pondérée)</div></div>
              </div>
              <div className="card card-pad flex items-center gap-4">
                <Ring val={d.stats.coveragePct} color="var(--green)" label="couverture" />
                <div className="stat"><div className="stat-value">{d.stats.coveragePct}%</div><div className="stat-label">Programme couvert</div></div>
              </div>
              <div className="card card-pad flex items-center gap-4">
                <div className="icon-tile" style={{ background: "var(--blue-wash)", borderColor: "transparent", fontSize: 20 }}>↻</div>
                <div className="stat"><div className="stat-value">{d.schedule.due}</div><div className="stat-label">Révisions dues / {d.schedule.total}</div></div>
              </div>
              <div className="card card-pad flex items-center gap-4">
                <div className="icon-tile" style={{ background: "var(--red-wash)", borderColor: "transparent", fontSize: 20 }}>🎯</div>
                <div className="stat"><div className="stat-value">{d.weaknesses.count}</div><div className="stat-label">Faiblesses suivies</div></div>
              </div>
            </section>
          )}

          {/* ── Actions rapides ── */}
          <section className="rise rise-2" style={{ marginBottom: 28 }}>
            <div className="section-head"><span className="section-title">Actions rapides</span></div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {actions.map((a) => (
                <Link key={a.label} href={a.href} className="card-link" style={{ padding: 16, borderRadius: "var(--r)" }}>
                  <div className="flex items-center gap-3">
                    <span className="icon-tile" style={a.primary ? { background: "var(--accent-wash)", borderColor: "var(--accent-line)" } : undefined}>{a.icon}</span>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{a.label}</div>
                      <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 1 }}>{a.desc}</div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>

          {/* ── Job en cours ── */}
          {d?.job && ["queued", "running", "verifying", "compiling"].includes(d.job.status) && (
            <section className="card card-pad rise" style={{ marginBottom: 28 }}>
              <div className="flex items-center justify-between gap-3 mb-2">
                <span style={{ fontSize: 13, fontWeight: 600 }}><span className="spinner" style={{ marginRight: 8 }} />Génération en cours · {d.job.type}</span>
                <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{d.job.progress}%</span>
              </div>
              <div className="progress"><div className="progress-bar" style={{ width: `${d.job.progress}%` }} /></div>
              <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 8 }}>{d.job.currentStep}</div>
            </section>
          )}

          <div className="grid gap-5 lg:grid-cols-3 rise rise-3">
            {/* ── Continuer / prochain type ── */}
            <section className="card card-pad lg:col-span-2">
              <div className="section-head"><span className="section-title">Continuer</span><Link href="/programme" className="btn btn-quiet btn-sm">tout le programme →</Link></div>
              {d?.analyzed && (d.next || d.cover) ? (
                <div className="flex flex-col gap-3">
                  {d.next && (
                    <Link href="/programme" className="inset flex items-center gap-3" style={{ padding: 14, textDecoration: "none" }}>
                      <span className="dot" style={{ background: CAT_COLOR[d.next.category] ?? "var(--accent)" }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14.5, fontWeight: 600, color: "var(--ink)" }}>{d.next.label}</div>
                        <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 1 }}>Recommandé · {d.next.category} · poids {d.next.examWeight}%{d.next.mastery != null ? ` · maîtrise ${d.next.mastery}/10` : " · jamais vu"}</div>
                      </div>
                      <span className="btn btn-primary btn-sm">M'entraîner</span>
                    </Link>
                  )}
                  {d.cover && d.cover.id !== d.next?.id && (
                    <Link href="/programme" className="inset flex items-center gap-3" style={{ padding: 14, textDecoration: "none" }}>
                      <span className="badge">Parcours</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14.5, fontWeight: 600, color: "var(--ink)" }}>{d.cover.label}</div>
                        <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 1 }}>Le plus lourd encore sous le seuil · poids {d.cover.examWeight}%</div>
                      </div>
                    </Link>
                  )}
                </div>
              ) : (
                <div className="empty">
                  <div className="empty-ico">📊</div>
                  <div className="empty-title">Programme pas encore analysé</div>
                  <div className="empty-sub">Cortex lit les vrais finals et en déduit les types d'exos et leur poids.</div>
                  <Link href="/programme" className="btn btn-primary mt-4" style={{ marginTop: 16 }}>Analyser le programme</Link>
                </div>
              )}
            </section>

            {/* ── Faiblesses ── */}
            <section className="card card-pad">
              <div className="section-head"><span className="section-title">Tes faiblesses</span><Link href="/faiblesses" className="btn btn-quiet btn-sm">→</Link></div>
              {d?.weaknesses.top.length ? (
                <div className="flex flex-col gap-2">
                  {d.weaknesses.top.map((w) => (
                    <Link key={w.id} href="/entrainement" className="inset flex items-center gap-2" style={{ padding: "10px 12px", textDecoration: "none" }}>
                      <span className="dot" style={{ background: w.severity >= 3 ? "var(--red)" : w.severity === 2 ? "var(--accent)" : "var(--ink-3)" }} />
                      <span style={{ fontSize: 13, color: "var(--ink)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.topic}</span>
                      <span style={{ fontSize: 11, color: "var(--ink-3)" }}>drill →</span>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="empty" style={{ padding: "26px 12px" }}>
                  <div className="empty-ico">🎯</div>
                  <div className="empty-sub" style={{ marginTop: 8 }}>Aucune faiblesse capturée.<br />Dépose un exo raté.</div>
                  <Link href="/faiblesses" className="btn btn-ghost btn-sm" style={{ marginTop: 14 }}>Capturer</Link>
                </div>
              )}
            </section>
          </div>

          {/* ── Examens récents ── */}
          <section className="card card-pad rise rise-4" style={{ marginTop: 20 }}>
            <div className="section-head"><span className="section-title">Examens & exos récents</span><Link href="/examens" className="btn btn-quiet btn-sm">tous →</Link></div>
            {d?.exams.length ? (
              <div className="flex flex-col" style={{ gap: 2 }}>
                {d.exams.map((e) => (
                  <div key={e.id} className="t-row" style={{ gridTemplateColumns: "auto 1fr auto auto" }}>
                    <span className="icon-tile icon-tile-sm" style={{ fontSize: 13 }}>📄</span>
                    <div>
                      <div style={{ fontSize: 13.5, fontWeight: 550, color: "var(--ink)" }}>Examen #{e.id}</div>
                      <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{e.questionCount} questions{e.verifySummary ? ` · ${e.verifySummary}` : ""}</div>
                    </div>
                    <span className={`tag ${e.status === "ready" ? "tag-green" : "tag-amber"}`}>{e.status === "ready" ? "prêt" : e.status}</span>
                    {e.url && <a href={e.url} target="_blank" rel="noopener" className="btn btn-ghost btn-sm">ouvrir</a>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">
                <div className="empty-ico">✦</div>
                <div className="empty-title">Aucun examen encore</div>
                <div className="empty-sub">Génère ton premier final blanc, ciblé sur tes faiblesses.</div>
                <Link href="/examens" className="btn btn-primary" style={{ marginTop: 16 }}>Générer un examen</Link>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
