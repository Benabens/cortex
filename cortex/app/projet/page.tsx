"use client";

import { useEffect, useMemo, useState } from "react";

// Types (miroir de lib/project-revision.ts ; le JSON est chargé via /api/projet)
type Block =
  | { type: "prose"; text: string }
  | { type: "callout"; label?: string; text: string }
  | { type: "code"; lang?: string; code: string; caption?: string }
  | { type: "table"; headers: string[]; rows: string[][]; caption?: string }
  | { type: "list"; items: string[] };
type Section = { id: string; title: string; milestone: "m1" | "m2" | "both"; summary: string; blocks: Block[] };
type ProfQuestion = { id: number; milestone: "m1" | "m2" | "both"; category: string; question: string; answer: string; keyPoint: string; codeRef?: string };
type Qcm = { id: number; milestone: "m1" | "m2"; topic: string; difficulty?: string; question: string; options: string[]; correct: "A" | "B" | "C" | "D"; explanation: string; verified?: boolean; verifyMethod?: string };
type OpenQuestion = { id: number; milestone: "m1" | "m2"; topic: string; question: string; answer: string; keyPoint: string };
type Data = {
  source: string;
  title?: string; note?: string;
  project?: { title: string; course: string; scipers: string[]; dataset: string; milestones: { id: string; label: string; methods: string[] }[] };
  sections?: Section[]; profQuestions?: ProfQuestion[]; qcm?: Qcm[]; open?: OpenQuestion[];
  stats?: { sections: number; profQuestions: number; qcm: number; qcmVerified: number; open: number };
};

const LETTERS = ["A", "B", "C", "D", "E", "F"] as const;
const msLabel = (m: string) => (m === "m1" ? "M1" : m === "m2" ? "M2" : "M1+M2");
const msTag = (m: string) => (m === "m1" ? "tag-blue" : m === "m2" ? "tag-amber" : "tag-green");

function BlockView({ b }: { b: Block }) {
  if (b.type === "prose")
    return <p className="text-[14px] leading-relaxed" style={{ color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{b.text}</p>;
  if (b.type === "callout")
    return (
      <div className="inset" style={{ padding: "10px 12px", borderLeft: "3px solid var(--accent)" }}>
        {b.label && <div className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--accent-ink)" }}>{b.label}</div>}
        <div className="text-[13.5px] leading-relaxed" style={{ color: "var(--ink)", whiteSpace: "pre-wrap" }}>{b.text}</div>
      </div>
    );
  if (b.type === "code")
    return (
      <figure>
        {b.caption && <figcaption className="text-[11.5px] mb-1" style={{ color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>{b.caption}</figcaption>}
        <pre className="text-[12.5px] overflow-x-auto" style={{ background: "var(--surface-2)", padding: 12, borderRadius: 8, color: "var(--ink)", lineHeight: 1.5 }}>{b.code}</pre>
      </figure>
    );
  if (b.type === "table")
    return (
      <div style={{ overflowX: "auto" }}>
        {b.caption && <div className="text-[11.5px] mb-1" style={{ color: "var(--ink-3)" }}>{b.caption}</div>}
        <table className="text-[13px]" style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>{b.headers.map((h, i) => <th key={i} style={{ textAlign: "left", padding: "5px 9px", borderBottom: "1px solid var(--line-strong)", color: "var(--ink)", fontWeight: 600 }}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {b.rows.map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => <td key={ci} style={{ padding: "5px 9px", borderBottom: "1px solid var(--line)", color: "var(--ink-2)", verticalAlign: "top", whiteSpace: "pre-wrap" }}>{c}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  if (b.type === "list")
    return <ul className="text-[13.5px] space-y-1" style={{ color: "var(--ink-2)", listStyle: "disc", paddingLeft: 20 }}>{b.items.map((it, i) => <li key={i} style={{ whiteSpace: "pre-wrap" }}>{it}</li>)}</ul>;
  return null;
}

export default function ProjetPage() {
  const [d, setD] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"explain" | "prof" | "qcm" | "open">("explain");
  const [ms, setMs] = useState<"all" | "m1" | "m2">("all");
  const [openSec, setOpenSec] = useState<Record<string, boolean>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [picked, setPicked] = useState<Record<number, number>>({});

  useEffect(() => { (async () => { try { setD(await (await fetch("/api/projet")).json()); } catch {} setLoading(false); })(); }, []);

  const mFilter = <T extends { milestone: string }>(arr: T[]) => arr.filter((x) => ms === "all" || x.milestone === ms || x.milestone === "both");

  const sections = useMemo(() => mFilter(d?.sections ?? []), [d, ms]);
  const profByCat = useMemo(() => {
    const m = new Map<string, ProfQuestion[]>();
    for (const q of mFilter(d?.profQuestions ?? [])) { if (!m.has(q.category)) m.set(q.category, []); m.get(q.category)!.push(q); }
    return [...m.entries()];
  }, [d, ms]);
  const qcms = useMemo(() => mFilter(d?.qcm ?? []), [d, ms]);
  const opens = useMemo(() => mFilter(d?.open ?? []), [d, ms]);

  const answered = qcms.filter((q) => picked[q.id] !== undefined);
  const correctCount = answered.filter((q) => LETTERS[picked[q.id]] === q.correct).length;

  const empty = !loading && (!d || d.source === "empty" || !(d.sections?.length));

  return (
    <main className="page page-wide">
      <header className="mb-6 rise">
        <p className="eyebrow">Révision projet · CS-233 — Machine Learning</p>
        <h1 className="h1 mt-2" style={{ fontSize: 28 }}>Maîtriser le projet (Milestones 1 &amp; 2) à 100 %.</h1>
        <p className="sub mt-2">{d?.note ?? "Le staff a annoncé des questions sur le projet à l'examen. Ici : tout le code expliqué (architecture, mécanique, choix, hyperparamètres), les questions que le prof peut poser avec leurs réponses, et des QCM/ouvertes pour s'auto-tester. Déjà prêt, rien à relancer."}</p>
      </header>

      {loading && <div className="card card-pad rise"><div className="skeleton" style={{ height: 140 }} /></div>}

      {empty && (
        <div className="card card-pad empty">
          <div className="empty-ico">📦</div>
          <div className="empty-title">Contenu pas encore présent</div>
          <div className="empty-sub">Le fichier <code className="kbd">data/ml/project-revision.json</code> n'a pas été trouvé. Fais un <code className="kbd">git pull</code> de la branche du projet.</div>
        </div>
      )}

      {!loading && d && !empty && (
        <>
          {/* Carte projet */}
          {d.project && (
            <section className="card card-pad mb-5 rise">
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <h2 className="text-[15px] font-semibold" style={{ color: "var(--ink)" }}>{d.project.title}</h2>
                {d.stats && <span className="tag tag-green" title="chargé depuis le fichier committé">pré-construit ✓</span>}
                <span className="tag">SCIPER {d.project.scipers.join(" / ")}</span>
              </div>
              <p className="text-[13.5px] mb-3" style={{ color: "var(--ink-2)" }}>{d.project.dataset}</p>
              <div className="flex flex-wrap gap-2">
                {d.project.milestones.map((m) => (
                  <div key={m.id} className="inset" style={{ padding: "8px 12px", flex: "1 1 260px" }}>
                    <div className="flex items-center gap-2 mb-1"><span className={`tag ${msTag(m.id)}`}>{m.label}</span></div>
                    <div className="text-[12.5px]" style={{ color: "var(--ink-2)" }}>{m.methods.join(" · ")}</div>
                  </div>
                ))}
              </div>
              {d.stats && (
                <div className="flex flex-wrap gap-2 mt-3 text-[12px]">
                  <span className="tag">{d.stats.sections} sections expliquées</span>
                  <span className="tag">{d.stats.profQuestions} questions du prof</span>
                  <span className="tag tag-blue">{d.stats.qcm} QCM ({d.stats.qcmVerified} vérifiés)</span>
                  <span className="tag tag-amber">{d.stats.open} ouvertes</span>
                </div>
              )}
            </section>
          )}

          {/* Onglets + filtre milestone */}
          <div className="flex items-center gap-3 flex-wrap mb-4">
            <div className="segmented">
              <button data-active={tab === "explain"} onClick={() => setTab("explain")}>Explication ({d.sections?.length ?? 0})</button>
              <button data-active={tab === "prof"} onClick={() => setTab("prof")}>Questions du prof ({d.profQuestions?.length ?? 0})</button>
              <button data-active={tab === "qcm"} onClick={() => setTab("qcm")}>QCM ({d.qcm?.length ?? 0})</button>
              <button data-active={tab === "open"} onClick={() => setTab("open")}>Ouvertes ({d.open?.length ?? 0})</button>
            </div>
            <div className="segmented" style={{ marginLeft: "auto" }}>
              <button data-active={ms === "all"} onClick={() => setMs("all")}>Tous</button>
              <button data-active={ms === "m1"} onClick={() => setMs("m1")}>M1</button>
              <button data-active={ms === "m2"} onClick={() => setMs("m2")}>M2</button>
            </div>
          </div>

          {/* EXPLICATION */}
          {tab === "explain" && (
            <div className="space-y-2">
              {sections.map((s) => (
                <div key={s.id} className="card" style={{ padding: 0 }}>
                  <button className="t-row w-full text-left" style={{ gridTemplateColumns: "auto 1fr auto", width: "100%" }} onClick={() => setOpenSec((o) => ({ ...o, [s.id]: !o[s.id] }))}>
                    <span className={`tag ${msTag(s.milestone)}`} style={{ minWidth: 56, justifyContent: "center" }}>{msLabel(s.milestone)}</span>
                    <span><span className="font-medium" style={{ color: "var(--ink)" }}>{s.title}</span><span className="block text-[12.5px] mt-0.5" style={{ color: "var(--ink-3)" }}>{s.summary}</span></span>
                    <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>{openSec[s.id] ? "▾" : "▸"}</span>
                  </button>
                  {openSec[s.id] && <div className="px-4 pb-4 pt-1 space-y-3">{s.blocks.map((b, i) => <BlockView key={i} b={b} />)}</div>}
                </div>
              ))}
            </div>
          )}

          {/* QUESTIONS DU PROF */}
          {tab === "prof" && (
            <div className="space-y-4">
              {profByCat.map(([cat, items]) => (
                <section key={cat}>
                  <h3 className="text-[13px] font-semibold uppercase tracking-wide mb-2" style={{ color: "var(--ink-3)" }}>{cat}</h3>
                  <div className="space-y-2">
                    {items.map((q) => {
                      const k = `prof:${q.id}`;
                      return (
                        <div key={q.id} className="card" style={{ padding: 0 }}>
                          <button className="t-row w-full text-left" style={{ gridTemplateColumns: "auto 1fr auto", width: "100%" }} onClick={() => setReveal((r) => ({ ...r, [k]: !r[k] }))}>
                            <span className={`tag ${msTag(q.milestone)}`} style={{ minWidth: 56, justifyContent: "center" }}>{msLabel(q.milestone)}</span>
                            <span className="font-medium text-[13.5px]" style={{ color: "var(--ink)" }}>{q.question}</span>
                            <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>{reveal[k] ? "▾" : "▸"}</span>
                          </button>
                          {reveal[k] && (
                            <div className="px-4 pb-3 space-y-2">
                              <p className="text-[13.5px] leading-relaxed" style={{ color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{q.answer}</p>
                              <div className="inset" style={{ padding: "8px 10px", borderLeft: "3px solid var(--green)" }}>
                                <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--green-ink)" }}>À retenir</span>
                                <div className="text-[13px] mt-0.5" style={{ color: "var(--ink)" }}>{q.keyPoint}</div>
                              </div>
                              {q.codeRef && <div className="text-[11.5px]" style={{ color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>↳ {q.codeRef}</div>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}

          {/* QCM auto-corrigés */}
          {tab === "qcm" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-[13px]" style={{ color: "var(--ink-3)" }}>
                <span className="tag tag-green">Score : {correctCount} / {answered.length} répondu(s)</span>
                {answered.length > 0 && <button className="btn btn-quiet btn-sm" onClick={() => setPicked({})}>réinitialiser</button>}
              </div>
              {qcms.map((q) => {
                const sel = picked[q.id];
                const done = sel !== undefined;
                const correctIdx = LETTERS.indexOf(q.correct);
                return (
                  <div key={q.id} className="card card-pad">
                    <div className="flex items-center gap-2 flex-wrap text-[12px] mb-2">
                      <span className={`tag ${msTag(q.milestone)}`}>{msLabel(q.milestone)}</span>
                      <span className="tag">{q.topic}</span>
                      {q.difficulty && <span className="tag">{q.difficulty}</span>}
                      {q.verified && <span className="tag tag-green" title={q.verifyMethod || "vérifié"}>✓ vérifié</span>}
                    </div>
                    <div className="text-[14px] font-medium mb-2" style={{ color: "var(--ink)", whiteSpace: "pre-wrap" }}>{q.question}</div>
                    <div className="space-y-1.5">
                      {q.options.map((opt, i) => {
                        const isCorrect = i === correctIdx;
                        const isPicked = i === sel;
                        let bg = "var(--surface-inset)", bd = "var(--line)", col = "var(--ink-2)";
                        if (done && isCorrect) { bg = "var(--green-wash)"; bd = "var(--green)"; col = "var(--green-ink)"; }
                        else if (done && isPicked && !isCorrect) { bg = "var(--red-wash)"; bd = "var(--red)"; col = "var(--red-ink)"; }
                        return (
                          <button key={i} disabled={done} onClick={() => setPicked((p) => ({ ...p, [q.id]: i }))}
                            className="w-full text-left text-[13.5px]" style={{ display: "flex", gap: 8, padding: "8px 11px", borderRadius: 8, border: `1px solid ${bd}`, background: bg, color: col, cursor: done ? "default" : "pointer" }}>
                            <span style={{ fontWeight: 600 }}>{LETTERS[i]}.</span><span style={{ whiteSpace: "pre-wrap" }}>{opt}</span>
                            {done && isCorrect && <span style={{ marginLeft: "auto" }}>✓</span>}
                            {done && isPicked && !isCorrect && <span style={{ marginLeft: "auto" }}>✗</span>}
                          </button>
                        );
                      })}
                    </div>
                    {done && (
                      <div className="inset mt-2" style={{ padding: "9px 11px" }}>
                        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--accent-ink)" }}>Explication</span>
                        <div className="text-[13px] mt-0.5 leading-relaxed" style={{ color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{q.explanation}</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* OUVERTES */}
          {tab === "open" && (
            <div className="space-y-2">
              {opens.map((q) => {
                const k = `open:${q.id}`;
                return (
                  <div key={q.id} className="card" style={{ padding: 0 }}>
                    <button className="t-row w-full text-left" style={{ gridTemplateColumns: "auto 1fr auto", width: "100%" }} onClick={() => setReveal((r) => ({ ...r, [k]: !r[k] }))}>
                      <span className={`tag ${msTag(q.milestone)}`} style={{ minWidth: 56, justifyContent: "center" }}>{msLabel(q.milestone)}</span>
                      <span><span className="font-medium text-[13.5px]" style={{ color: "var(--ink)" }}>{q.question}</span><span className="block text-[12px] mt-0.5" style={{ color: "var(--ink-3)" }}>{q.topic}</span></span>
                      <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>{reveal[k] ? "▾ corrigé" : "▸ corrigé"}</span>
                    </button>
                    {reveal[k] && (
                      <div className="px-4 pb-3 space-y-2">
                        <p className="text-[13.5px] leading-relaxed" style={{ color: "var(--ink-2)", whiteSpace: "pre-wrap" }}>{q.answer}</p>
                        <div className="inset" style={{ padding: "8px 10px", borderLeft: "3px solid var(--green)" }}>
                          <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--green-ink)" }}>À retenir</span>
                          <div className="text-[13px] mt-0.5" style={{ color: "var(--ink)" }}>{q.keyPoint}</div>
                        </div>
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
