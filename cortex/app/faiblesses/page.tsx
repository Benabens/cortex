"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Related = {
  itemId: number;
  title: string | null;
  sourceType: string;
  sourceTitle: string;
  lectureId: string | null;
  href: string;
};
type Weakness = {
  id: number;
  topic: string;
  description: string | null;
  screenshotUrl: string | null;
  severity: number;
  analyzed: boolean;
  source: string;
  theme: string | null;
  loggedAt: string | null;
  related: Related[];
};
type ThemeRow = { theme: string; count: number; avgSeverity: number; topics: string[] };

const SEV = [
  { v: 1, label: "léger", color: "var(--green)" },
  { v: 2, label: "moyen", color: "var(--accent)" },
  { v: 3, label: "gros", color: "var(--red)" },
];

export default function FaiblessesPage() {
  const [list, setList] = useState<Weakness[]>([]);
  const [byTheme, setByTheme] = useState<ThemeRow[]>([]);
  const [topic, setTopic] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState(2);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // intake conversation (Phase 5)
  const [convo, setConvo] = useState("");
  const [mining, setMining] = useState(false);
  const [mineMsg, setMineMsg] = useState<string | null>(null);
  const [mineErr, setMineErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/weaknesses");
    const d = await r.json();
    setList(d.weaknesses ?? []);
    setByTheme(d.byTheme ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function mine() {
    if (convo.trim().length < 40) return;
    setMining(true);
    setMineErr(null);
    setMineMsg(null);
    try {
      const r = await fetch("/api/weaknesses/mine", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: convo }) });
      const d = await r.json();
      if (!r.ok) throw new Error(r.status === 503 ? "Claude Code (Max) non joignable — lance l'app sur ta machine connectée." : d.error ?? "Échec");
      setMineMsg(d.created ? `${d.created} faiblesse(s) extraite(s) et classée(s).` : (d.note ?? "Aucune faiblesse claire détectée."));
      setConvo("");
      await load();
    } catch (e: any) {
      setMineErr(String(e.message ?? e));
    } finally {
      setMining(false);
    }
  }

  function pickFile(f: File | null) {
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
  }

  // Coller une image depuis le presse-papier (Cmd+Shift+4 → coller)
  const onPaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) {
          pickFile(new File([f], `screenshot.${f.type.split("/")[1] || "png"}`, { type: f.type }));
          e.preventDefault();
        }
      }
    }
  }, []);
  useEffect(() => {
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onPaste]);

  const canSubmit = !!(topic.trim() || description.trim() || file);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.set("topic", topic);
      fd.set("description", description);
      fd.set("severity", String(severity));
      if (file) fd.set("screenshot", file);
      const r = await fetch("/api/weaknesses", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Échec");
      setTopic("");
      setDescription("");
      setSeverity(2);
      pickFile(null);
      if (fileRef.current) fileRef.current.value = "";
      await load();
      // Traitement IA automatique via Claude Code (Max) — structure la faiblesse juste après l'ajout.
      if (d.id) process(d.id);
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  // Analyse via Claude Code (abonnement Max, gratuit) — pas l'API payante.
  async function process(id: number) {
    setAnalyzing(id);
    setErr(null);
    try {
      const r = await fetch("/api/weaknesses/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const d = await r.json();
      if (!r.ok) {
        if (r.status === 503) {
          throw new Error(
            "Claude Code (Max) n'est pas joignable ici. Lance l'app sur ta machine où `claude` est installé et connecté à ton Max, puis réessaie."
          );
        }
        throw new Error(d.error ?? "Échec de l'analyse");
      }
      await load();
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setAnalyzing(null);
    }
  }

  async function remove(id: number) {
    await fetch(`/api/weaknesses?id=${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <main className="page page-narrow">
      <header className="mb-6">
        <p className="eyebrow">Faiblesses</p>
        <h1 className="h1 mt-2" style={{ fontSize: 28 }}>Tes points faibles, capturés.</h1>
      </header>

      {/* Tableau de bord par thème (le « classement » des incompréhensions) */}
      {byTheme.length > 0 && (
        <div className="card card-pad mb-6">
          <h2 className="text-[12px] font-semibold uppercase tracking-wide mb-3" style={{ color: "var(--ink-2)", letterSpacing: "0.04em" }}>
            Par thème — où ça coince le plus
          </h2>
          <div className="flex flex-col gap-2">
            {byTheme.map((t) => {
              const sev = SEV.find((s) => s.v === Math.round(t.avgSeverity)) ?? SEV[1];
              const max = Math.max(...byTheme.map((x) => x.count));
              return (
                <div key={t.theme} className="flex items-center gap-3">
                  <span className="text-[13px] font-medium shrink-0" style={{ color: "var(--ink)", width: 150 }} title={t.topics.join(" · ")}>{t.theme}</span>
                  <div className="flex-1 h-2.5 rounded-full overflow-hidden" style={{ background: "var(--surface-2)" }}>
                    <div className="h-full" style={{ width: `${(t.count / max) * 100}%`, background: sev.color }} />
                  </div>
                  <span className="text-[12px] tabular-nums shrink-0" style={{ color: "var(--ink-3)", width: 90, textAlign: "right" }}>{t.count} · grav {t.avgSeverity}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Importer une discussion → faiblesses (Phase 5) */}
      <div className="card card-pad mb-6">
        <h2 className="text-[15px] font-semibold mb-1" style={{ color: "var(--ink)" }}>💬 Importer une discussion</h2>
        <p className="text-[13px] mb-3" style={{ color: "var(--ink-2)" }}>
          Colle une conversation (questions posées à Claude, exos résolus ensemble, là où tu as buté). Cortex en extrait tes
          <strong style={{ color: "var(--ink)" }}> faiblesses classées par thème</strong>, auto-liées au corpus — elles ciblent ensuite les exos/examens générés.
        </p>
        <textarea className="textarea mb-2" rows={4} placeholder="Colle ici une discussion entière (ou une journée de chat)…" value={convo} onChange={(e) => setConvo(e.target.value)} style={{ fontSize: 13 }} />
        <div className="flex items-center gap-3">
          <button className="btn btn-primary" disabled={mining || convo.trim().length < 40} onClick={mine}>{mining ? "Analyse… (~30s)" : "Extraire mes faiblesses"}</button>
          {mineMsg && <span className="text-[12px]" style={{ color: "var(--green)" }}>{mineMsg}</span>}
          {mineErr && <span className="text-[12px]" style={{ color: "var(--red)" }}>{mineErr}</span>}
        </div>
      </div>

      {/* Formulaire d'intake */}
      <form onSubmit={submit} className="card card-pad mb-8">
        <p className="mb-4 text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
          Dépose juste un <strong style={{ color: "var(--ink)" }}>screenshot d'exo</strong>, un <strong style={{ color: "var(--ink)" }}>slide de cours</strong>, ou écris une note. Dès l'ajout, <strong style={{ color: "var(--ink)" }}>Claude lit l'image et structure ta faiblesse automatiquement</strong> — via ton abonnement Max (gratuit, pas l'API payante). Le sujet est optionnel.
        </p>
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Sujet (optionnel — l'IA le déduit du screenshot)"
          className="input mb-3"
          style={{ fontSize: 14 }}
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optionnel : ce que tu n'as pas compris…"
          rows={3}
          className="textarea mb-3"
          style={{ fontSize: 14 }}
        />
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="flex gap-1.5">
            {SEV.map((s) => (
              <button
                key={s.v}
                type="button"
                onClick={() => setSeverity(s.v)}
                className="chip"
                style={{
                  borderColor: severity === s.v ? s.color : "var(--line-strong)",
                  color: severity === s.v ? s.color : "var(--ink-2)",
                  fontWeight: severity === s.v ? 600 : 400,
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
          <label className="cursor-pointer">
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
            <span className="chip">📎 screenshot</span>
          </label>
          <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>…ou colle une image (Cmd+V)</span>
        </div>
        {preview && (
          <img src={preview} alt="aperçu" className="mb-3 max-h-40 rounded-lg border" style={{ borderColor: "var(--line)" }} />
        )}
        <button type="submit" disabled={saving || !canSubmit} className="btn btn-primary">
          {saving ? "Enregistrement…" : "Ajouter la faiblesse"}
        </button>
        {err && <p className="mt-2.5 text-[12px]" style={{ color: "var(--red)" }}>{err}</p>}
      </form>

      {/* Bandeau : faiblesses pas encore structurées par l'IA */}
      {list.some((w) => !w.analyzed) && (
        <div className="mb-5 rounded-xl px-4 py-3 text-[13px] leading-relaxed" style={{ background: "var(--accent-wash)", color: "var(--ink-2)" }}>
          <strong style={{ color: "var(--accent-ink)" }}>{list.filter((w) => !w.analyzed).length} faiblesse(s) pas encore structurée(s).</strong>{" "}
          L'analyse se lance toute seule à l'ajout ; si l'une est restée en attente (app pas lancée sur ta machine, ou erreur), clique <strong style={{ color: "var(--accent-ink)" }}>✦ analyser</strong> dessus — c'est gratuit via ton Max.
        </div>
      )}

      {/* Liste */}
      <div className="space-y-4">
        {list.length === 0 && (
          <p className="text-[14px]" style={{ color: "var(--ink-3)" }}>
            Aucune faiblesse pour l'instant. Ajoute un exo raté ci-dessus.
          </p>
        )}
        {list.map((w) => {
          const sev = SEV.find((s) => s.v === w.severity) ?? SEV[1];
          return (
            <div key={w.id} className="card card-pad">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="dot" style={{ background: sev.color }} />
                  <h3 className="text-[15px] font-semibold" style={{ color: "var(--ink)" }}>{w.topic}</h3>
                  {!w.analyzed && <span className="badge">à analyser</span>}
                  {w.source === "conversation" && <span className="badge" style={{ borderColor: "var(--blue)", color: "var(--blue)" }}>💬 discussion</span>}
                  {w.theme && <span className="text-[11px]" style={{ color: "var(--ink-3)" }}>{w.theme}</span>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button onClick={() => process(w.id)} disabled={analyzing === w.id} className="btn btn-quiet" style={{ color: "var(--blue)" }}>
                    {analyzing === w.id ? "Claude analyse… (~20s)" : w.analyzed ? "↻ ré-analyser" : "✦ analyser"}
                  </button>
                  <button onClick={() => remove(w.id)} className="btn btn-quiet">suppr</button>
                </div>
              </div>
              {w.screenshotUrl && (
                <img src={w.screenshotUrl} alt="" className="mt-3 max-h-56 rounded-lg border" style={{ borderColor: "var(--line)" }} />
              )}
              {w.description && (
                <p className="mt-3 whitespace-pre-wrap text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>{w.description}</p>
              )}
              {w.related.length > 0 && (
                <div className="mt-4">
                  <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: "var(--ink-3)" }}>À revoir dans ton corpus</div>
                  <ul className="flex flex-wrap gap-1.5">
                    {w.related.map((r) => (
                      <li key={r.itemId}>
                        <a href={r.href} target="_blank" rel="noopener" className="chip" style={{ color: "var(--ink-2)" }}>
                          {r.lectureId ? r.lectureId.toUpperCase() + " · " : ""}{(r.title ?? r.sourceTitle).slice(0, 42)}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}
