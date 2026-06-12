"use client";

import CmdHint from "@/app/components/CmdHint";
import { useCallback, useEffect, useRef, useState } from "react";

const EXO_ACTIVE = ["queued", "running", "verifying", "compiling"];

type Drill = { concept: string; statement_html: string; hints: string[]; solution_html: string };
type Check = { verdict: "correct" | "partial" | "wrong"; feedback: string; correct_solution: string };

const VERDICT: Record<string, { label: string; color: string }> = {
  correct: { label: "Juste ✓", color: "var(--green)" },
  partial: { label: "Partiel", color: "var(--accent)" },
  wrong: { label: "Faux", color: "var(--red)" },
};

export default function EntrainementPage() {
  // ---- Drilling ----
  const [due, setDue] = useState<string[]>([]);
  const [weak, setWeak] = useState<string[]>([]);
  const [concept, setConcept] = useState("");
  const [drill, setDrill] = useState<Drill | null>(null);
  const [shown, setShown] = useState(0);
  const [showSol, setShowSol] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ---- Exercice ciblé (PDF format examen, via job arrière-plan) ----
  const [exoTarget, setExoTarget] = useState("");
  const [exoJob, setExoJob] = useState<any>(null);
  const exoPoll = useRef<any>(null);
  const [exoErr, setExoErr] = useState<string | null>(null);
  const [exoErrCmd, setExoErrCmd] = useState<string | null>(null);
  const [exoImg, setExoImg] = useState<File | null>(null);
  const [exoNote, setExoNote] = useState("");

  // ---- Exo Labs (NS13) : moule Q6 2025, contenu = le vrai code du lab ----
  const [labTopic, setLabTopic] = useState("");
  const [labJob, setLabJob] = useState<any>(null);
  const labPoll = useRef<any>(null);
  const [labErr, setLabErr] = useState<string | null>(null);
  const [labErrCmd, setLabErrCmd] = useState<string | null>(null);

  // ---- Check my solution ----
  const [statement, setStatement] = useState("");
  const [answer, setAnswer] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [checking, setChecking] = useState(false);
  const [cerr, setCerr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await (await fetch("/api/drill")).json();
      setDue(d.due ?? []);
      setWeak(d.weaknesses ?? []);
    } catch {}
  }, []);
  const pollExo = useCallback((id: number) => {
    clearInterval(exoPoll.current);
    exoPoll.current = setInterval(async () => {
      try {
        const j = await (await fetch(`/api/jobs/${id}`)).json();
        setExoJob(j);
        if (!EXO_ACTIVE.includes(j.status)) clearInterval(exoPoll.current);
      } catch {}
    }, 2000);
  }, []);

  const pollLab = useCallback((id: number) => {
    clearInterval(labPoll.current);
    labPoll.current = setInterval(async () => {
      try {
        const j = await (await fetch(`/api/jobs/${id}`)).json();
        setLabJob(j);
        if (!EXO_ACTIVE.includes(j.status)) clearInterval(labPoll.current);
      } catch {}
    }, 2000);
  }, []);

  useEffect(() => {
    load();
    (async () => {
      try {
        const d = await (await fetch("/api/jobs?type=exercise")).json();
        if (d.active && EXO_ACTIVE.includes(d.active.status)) { setExoJob(d.active); pollExo(d.active.id); }
      } catch {}
      try {
        const d = await (await fetch("/api/jobs?type=lab-exercise")).json();
        if (d.active && EXO_ACTIVE.includes(d.active.status)) { setLabJob(d.active); pollLab(d.active.id); }
      } catch {}
    })();
    return () => { clearInterval(exoPoll.current); clearInterval(labPoll.current); };
  }, [load, pollExo, pollLab]);

  async function cancelLab() {
    if (!labJob) return;
    clearInterval(labPoll.current);
    try { await fetch(`/api/jobs/${labJob.id}/cancel`, { method: "POST" }); } catch {}
    setLabJob(null);
    setLabErr(null);
  }

  async function genLab(lab: string, topic: string) {
    if (!lab && !topic.trim()) return;
    setLabErr(null);
    setLabErrCmd(null);
    setLabJob(null);
    try {
      const r = await fetch("/api/labs/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lab, topic }) });
      const d = await r.json();
      if (!r.ok) { setLabErr(d.error ?? "Échec"); setLabErrCmd(d.command ?? null); return; }
      if (d.jobId) { setLabJob({ id: d.jobId, status: "queued", progress: 0, currentStep: "Démarrage…", resultPath: null, log: [] }); pollLab(d.jobId); }
    } catch (e: any) { setLabErr(String(e.message ?? e)); }
  }

  async function cancelExo() {
    if (!exoJob) return;
    clearInterval(exoPoll.current);
    try { await fetch(`/api/jobs/${exoJob.id}/cancel`, { method: "POST" }); } catch {}
    setExoJob(null);
    setExoErr(null);
  }

  async function genExo(target: string) {
    if (!target.trim() && !exoImg) return;
    setExoErr(null);
    setExoErrCmd(null);
    setExoJob(null);
    try {
      let r: Response;
      if (exoImg) {
        // Phase 3 — image → exo : multipart (image + sujet optionnel + note)
        const fd = new FormData();
        if (target.trim()) fd.set("target", target);
        if (exoNote.trim()) fd.set("note", exoNote);
        fd.set("image", exoImg);
        r = await fetch("/api/exercises/generate", { method: "POST", body: fd });
      } else {
        r = await fetch("/api/exercises/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target }) });
      }
      const d = await r.json();
      if (!r.ok) { setExoErr(d.error ?? "Échec"); setExoErrCmd(d.command ?? null); return; }
      if (d.jobId) { setExoJob({ id: d.jobId, status: "queued", progress: 0, currentStep: "Démarrage…", resultPath: null, log: [] }); pollExo(d.jobId); setExoImg(null); setExoNote(""); }
    } catch (e: any) { setExoErr(String(e.message ?? e)); }
  }

  async function genDrill(c: string) {
    if (!c.trim()) return;
    setBusy(true);
    setErr(null);
    setDrill(null);
    setShown(0);
    setShowSol(false);
    try {
      const r = await fetch("/api/drill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ concept: c }) });
      const d = await r.json();
      if (!r.ok) throw new Error(r.status === 503 ? "Claude Code (Max) non joignable — lance l'app sur ta machine connectée." : d.error ?? "Échec");
      setDrill(d.drill);
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function runCheck(e: React.FormEvent) {
    e.preventDefault();
    if (!statement.trim() || (!answer.trim() && !file)) return;
    setChecking(true);
    setCerr(null);
    setCheck(null);
    try {
      const fd = new FormData();
      fd.set("statement", statement);
      fd.set("answer", answer);
      if (file) fd.set("image", file);
      const r = await fetch("/api/check-solution", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(r.status === 503 ? "Claude Code (Max) non joignable — lance l'app sur ta machine connectée." : d.error ?? "Échec");
      setCheck(d.result);
    } catch (e: any) {
      setCerr(String(e.message ?? e));
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="page page-narrow">
      <header className="mb-6">
        <p className="eyebrow">Entraînement</p>
        <h1 className="h1 mt-2" style={{ fontSize: 28 }}>Drille et fais-toi corriger.</h1>
      </header>

      {/* ---------- Exercice ciblé (PDF format examen) ---------- */}
      <section className="card card-pad mb-8">
        <h2 className="text-[15px] font-semibold mb-1" style={{ color: "var(--ink)" }}>Exercice ciblé — format examen (PDF)</h2>
        <p className="text-[13px] mb-3" style={{ color: "var(--ink-2)" }}>
          Tape un point faible précis <strong style={{ color: "var(--ink)" }}>ou colle une image d'exo</strong> (screenshot d'examen, de série, ou un exo que tu as raté) → UN exercice qualité examen du même type, <strong style={{ color: "var(--ink)" }}>sans page de garde</strong>, ancré sur les vrais finals. Généré en arrière-plan — tu peux recharger.
        </p>
        {exoJob && EXO_ACTIVE.includes(exoJob.status) ? (
          <div>
            <div className="progress">
              <div className="progress-bar" style={{ width: `${exoJob.progress}%` }} />
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <div className="text-[13px]" style={{ color: "var(--ink-2)" }}>{exoJob.currentStep}</div>
              <button className="btn btn-quiet" onClick={cancelExo}>annuler</button>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex gap-2">
              <input className="input" placeholder="ex. TCP Reno : cwnd après triple-dup-ACK · ou laisse vide si tu joins une image" value={exoTarget} onChange={(e) => setExoTarget(e.target.value)} style={{ fontSize: 14 }} />
              <button className="btn btn-primary" onClick={() => genExo(exoTarget)}>✦ Exo</button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="chip cursor-pointer">📎 image d'un exo
                <input type="file" accept="image/*" className="hidden" onChange={(e) => setExoImg(e.target.files?.[0] ?? null)} />
              </label>
              {exoImg && <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>{exoImg.name}</span>}
              {exoImg && <button className="btn btn-quiet" onClick={() => setExoImg(null)}>retirer</button>}
              {exoImg && (
                <input className="input" style={{ fontSize: 13, flex: 1, minWidth: 180 }} placeholder="(optionnel) ce que tu n'as pas compris / pourquoi tu as raté" value={exoNote} onChange={(e) => setExoNote(e.target.value)} />
              )}
            </div>
            {exoImg && <p className="mt-1 text-[12px]" style={{ color: "var(--accent-ink)" }}>→ exo neuf du même type que l'image, format examen, vérifié.</p>}
          </div>
        )}
        {exoJob?.status === "done" && exoJob.resultPath && (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[13px]" style={{ color: "var(--green)" }}>Exercice prêt ✓</span>
            <a className="btn btn-ghost" href={exoJob.resultPath} target="_blank" rel="noopener">ouvrir l'énoncé (PDF)</a>
            <a className="btn btn-quiet" style={{ color: "var(--green)" }} href={exoJob.resultPath.replace(/(\.pdf)(\?|$)/, "-corrige$1$2")} target="_blank" rel="noopener">corrigé</a>
          </div>
        )}
        {exoJob?.status === "error" && <p className="mt-2 text-[12px]" style={{ color: "var(--red)" }}>Échec : {exoJob.error}</p>}
        {exoErr && <p className="mt-2 text-[12px]" style={{ color: "var(--red)" }}>{exoErr}<CmdHint cmd={exoErrCmd} /></p>}
      </section>

      {/* ---------- Exo Labs : moule Q6 2025 (les 8% du final) ---------- */}
      <section className="card card-pad mb-8">
        <h2 className="text-[15px] font-semibold mb-1" style={{ color: "var(--ink)" }}>Exo Labs — format « question Projet » (Q6 2025)</h2>
        <p className="text-[13px] mb-3" style={{ color: "var(--ink-2)" }}>
          Les <strong style={{ color: "var(--ink)" }}>8% Labs</strong> du final auront le format de la Q6 du Final 2025 (décision staff) : conceptuel + <strong style={{ color: "var(--ink)" }}>écrire une fonction C du lab</strong> + ownership/debug. Choisis un lab (ou un sujet) → un exo NEUF dans ce moule, sur le <strong style={{ color: "var(--ink)" }}>vrai code de tes labs</strong>, vérifié.
        </p>
        {labJob && EXO_ACTIVE.includes(labJob.status) ? (
          <div>
            <div className="progress">
              <div className="progress-bar" style={{ width: `${labJob.progress}%` }} />
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <div className="text-[13px]" style={{ color: "var(--ink-2)" }}>{labJob.currentStep}</div>
              <button className="btn btn-quiet" onClick={cancelLab}>annuler</button>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {[
                { id: "lab1", t: "Lab 1 · Warmup C" },
                { id: "lab2", t: "Lab 2 · Client-serveur UDP" },
                { id: "lab4", t: "Lab 4 · Filesystem direntv6" },
                { id: "lab5", t: "Lab 5 · Multi-threading" },
              ].map((l) => (
                <button key={l.id} className="chip" onClick={() => genLab(l.id, labTopic)} style={{ borderColor: "var(--blue)", color: "var(--blue)" }}>
                  {l.t}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input className="input" placeholder="…ou un sujet précis : « inode walk », « table de mutex », « ownership buffer réseau »" value={labTopic} onChange={(e) => setLabTopic(e.target.value)} style={{ fontSize: 14 }} />
              <button className="btn btn-primary" onClick={() => genLab("", labTopic)}>✦ Exo Labs</button>
            </div>
          </div>
        )}
        {labJob?.status === "done" && labJob.resultPath && (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[13px]" style={{ color: "var(--green)" }}>Exercice Labs prêt ✓</span>
            <a className="btn btn-ghost" href={labJob.resultPath} target="_blank" rel="noopener">ouvrir l'énoncé (PDF)</a>
            <a className="btn btn-quiet" style={{ color: "var(--green)" }} href={labJob.resultPath.replace(/(\.pdf)(\?|$)/, "-corrige$1$2")} target="_blank" rel="noopener">corrigé</a>
          </div>
        )}
        {labJob?.status === "error" && <p className="mt-2 text-[12px]" style={{ color: "var(--red)" }}>Échec : {labJob.error}</p>}
        {labErr && <p className="mt-2 text-[12px]" style={{ color: "var(--red)" }}>{labErr}<CmdHint cmd={labErrCmd} /></p>}
      </section>

      {/* ---------- Drilling ---------- */}
      <section className="card card-pad mb-8">
        <h2 className="text-[15px] font-semibold mb-1" style={{ color: "var(--ink)" }}>Drilling ciblé</h2>
        <p className="text-[13px] mb-3" style={{ color: "var(--ink-2)" }}>
          Une question ciblée sur un concept, avec 5 indices révélés un par un (du plus vague au plus précis).
        </p>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {[...weak.map((w) => ({ t: w, k: "w" })), ...due.map((d) => ({ t: d, k: "d" }))].slice(0, 14).map((x, i) => (
            <button key={i} className="chip" onClick={() => { setConcept(x.t); genDrill(x.t); }}
              style={x.k === "w" ? { borderColor: "var(--accent)", color: "var(--accent-ink)" } : undefined}>
              {x.t.slice(0, 40)}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input className="input" placeholder="…ou tape un concept (ex. TCP slow start, inode walk)" value={concept} onChange={(e) => setConcept(e.target.value)} style={{ fontSize: 14 }} />
          <button className="btn btn-primary" disabled={busy} onClick={() => genDrill(concept)}>{busy ? "Génère…" : "✦ Drill"}</button>
        </div>
        {err && <p className="mt-2 text-[12px]" style={{ color: "var(--red)" }}>{err}</p>}

        {drill && (
          <div className="mt-5">
            <div className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--ink-3)" }}>{drill.concept}</div>
            <div className="prose-exam text-[14px]" style={{ color: "var(--ink)" }} dangerouslySetInnerHTML={{ __html: drill.statement_html }} />
            <div className="mt-4 space-y-2">
              {drill.hints.slice(0, shown).map((h, i) => (
                <div key={i} className="rounded-lg px-3 py-2 text-[13px]" style={{ background: "var(--accent-wash)", color: "var(--ink-2)" }}>
                  <strong style={{ color: "var(--accent-ink)" }}>Indice {i + 1} :</strong> <span dangerouslySetInnerHTML={{ __html: h }} />
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {shown < drill.hints.length && (
                <button className="btn btn-ghost" onClick={() => setShown(shown + 1)}>💡 Indice suivant ({shown}/{drill.hints.length})</button>
              )}
              <button className="btn btn-quiet" style={{ color: "var(--blue)" }} onClick={() => setShowSol(!showSol)}>{showSol ? "cacher le corrigé" : "voir le corrigé"}</button>
            </div>
            {showSol && (
              <div className="mt-3 rounded-lg p-3 text-[13px]" style={{ background: "var(--surface-2)", border: "1px solid var(--line)" }} dangerouslySetInnerHTML={{ __html: drill.solution_html }} />
            )}
          </div>
        )}
      </section>

      {/* ---------- Check my solution ---------- */}
      <section className="card card-pad">
        <h2 className="text-[15px] font-semibold mb-1" style={{ color: "var(--ink)" }}>Vérifie ma solution</h2>
        <p className="text-[13px] mb-3" style={{ color: "var(--ink-2)" }}>
          Colle une question + ta réponse (texte ou photo). L'IA la re-résout et te dit où tu te trompes.
        </p>
        <form onSubmit={runCheck}>
          <textarea className="textarea mb-2" rows={3} placeholder="L'énoncé de la question…" value={statement} onChange={(e) => setStatement(e.target.value)} style={{ fontSize: 13 }} />
          <textarea className="textarea mb-2" rows={3} placeholder="Ta réponse (ou joins une photo ci-dessous)…" value={answer} onChange={(e) => setAnswer(e.target.value)} style={{ fontSize: 13 }} />
          <div className="flex items-center gap-3 mb-2">
            <label className="chip cursor-pointer">📎 photo de ta réponse
              <input type="file" accept="image/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            {file && <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>{file.name}</span>}
          </div>
          <button className="btn btn-primary" disabled={checking}>{checking ? "Correction…" : "Vérifier ma réponse"}</button>
          {cerr && <p className="mt-2 text-[12px]" style={{ color: "var(--red)" }}>{cerr}</p>}
        </form>
        {check && (
          <div className="mt-4">
            <span className="badge" style={{ background: "transparent", border: `1px solid ${VERDICT[check.verdict]?.color}`, color: VERDICT[check.verdict]?.color }}>
              {VERDICT[check.verdict]?.label ?? check.verdict}
            </span>
            <p className="mt-2 text-[13px] whitespace-pre-wrap" style={{ color: "var(--ink)" }}>{check.feedback}</p>
            <details className="mt-2">
              <summary className="text-[12px] cursor-pointer" style={{ color: "var(--blue)" }}>solution correcte</summary>
              <p className="mt-1 text-[13px] whitespace-pre-wrap" style={{ color: "var(--ink-2)" }}>{check.correct_solution}</p>
            </details>
          </div>
        )}
      </section>
    </main>
  );
}
