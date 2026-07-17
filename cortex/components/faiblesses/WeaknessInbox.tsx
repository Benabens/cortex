"use client";

import { useRef, useState } from "react";
import { Sparkles, ImagePlus, Check, CloudOff, AlertTriangle, X } from "lucide-react";
import { SEVERITY, type Severity } from "@/lib/ux/labels";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SeverityMeter } from "@/components/viz/SeverityMeter";
import { apiPost, useCourse, type ApiError } from "@/lib/ux/api";
import { sevOf, type MineResp, type MinedItem } from "@/lib/ux/weaknesses";
import { cn } from "@/lib/ux/cn";

const MIN_MINE_CHARS = 40; // au-delà = « discussion » à miner (seuil back = mine/route.ts)

/**
 * Ajout d'une lacune — UNE seule zone (REFONTE ALLÉGÉE). Le routage se fait selon le CONTENU :
 *  — un screenshot / exo déposé → POST /api/weaknesses (image + note + sévérité) — marche hors-ligne ;
 *  — une longue discussion collée (≥ 40 car.) → POST /api/weaknesses/mine (Claude Max ; 503 géré) ;
 *  — une note courte → POST /api/weaknesses (note manuelle + sévérité).
 */
export function WeaknessInbox({ onAdded }: { onAdded: () => void }) {
  const { courseId } = useCourse();
  const fileRef = useRef<HTMLInputElement>(null);

  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sev, setSev] = useState(2);
  const [busy, setBusy] = useState(false);
  const [mined, setMined] = useState<MinedItem[] | null>(null);
  const [note, setNote] = useState<string | null>(null); // note d'info (ex. « aucune lacune détectée »)
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<{ offline: boolean; message: string } | null>(null);

  const reset = () => { setError(null); setNote(null); setSavedMsg(null); setMined(null); };

  const saveWeakness = async (description: string) => {
    const form = new FormData();
    if (description) form.append("description", description);
    form.append("severity", String(sev));
    if (file) form.append("screenshot", file);
    const res = await fetch(`/api/weaknesses?course=${encodeURIComponent(courseId)}`, { method: "POST", body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? `Erreur ${res.status}`);
    }
    setText("");
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
    setSavedMsg("Lacune ajoutée au suivi — Cortex l’analysera pour la relier au cours.");
    onAdded();
  };

  const mineText = async (t: string) => {
    const d = await apiPost<MineResp>("/api/weaknesses/mine", courseId, { text: t });
    setMined(d.mined ?? []);
    if (d.created === 0) setNote(d.note ?? "Aucune lacune claire détectée dans cette discussion.");
    else { setText(""); onAdded(); }
  };

  const submit = async () => {
    if (busy) return;
    reset();
    const t = text.trim();
    if (!file && !t) {
      setError({ offline: false, message: "Colle une discussion, un énoncé, ou ajoute un screenshot / une note." });
      return;
    }
    setBusy(true);
    try {
      if (file) await saveWeakness(t); // image (+ note) → ajout direct, hors-ligne OK
      else if (t.length >= MIN_MINE_CHARS) await mineText(t); // discussion → minage LLM
      else await saveWeakness(t); // note courte → ajout manuel
    } catch (e) {
      const err = e as ApiError;
      setError({
        offline: err.status === 503,
        message:
          err.status === 503
            ? "Claude Max n’est pas joignable. Lance Cortex sur ta machine connectée, puis réessaie — ton texte reste dans le champ."
            : err.message || "L’ajout a échoué. Réessaie.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel accent-field relative overflow-hidden rounded-xl p-5 sm:p-6" aria-labelledby="inbox-title">
      <div
        className="pointer-events-none absolute -right-24 -top-24 size-56 rounded-full opacity-50 blur-3xl"
        style={{ background: "radial-gradient(circle, color-mix(in oklch, var(--color-violet) 40%, transparent), transparent 70%)" }}
        aria-hidden="true"
      />
      <div className="relative">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-violet-hi" strokeWidth={2.5} />
          <h2 id="inbox-title" className="text-[1.05rem] font-semibold text-ink-1">Ajoute une lacune</h2>
        </div>
        <p className="mt-1 text-[0.88rem] text-ink-2">
          Colle une discussion, un énoncé raté, ou dépose un screenshot — Cortex détecte et suit tes lacunes.
        </p>

        {/* zone unique : texte (discussion / énoncé / note) */}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          aria-label="Discussion, énoncé, ou note sur la lacune"
          placeholder="Colle une discussion (ChatGPT, Slack…), un énoncé, ou écris ce qui t’a piégé…"
          className="mt-4 w-full resize-none rounded-lg border border-line-strong bg-surface-2/40 p-3.5 text-[0.9rem] text-ink-1 placeholder:text-ink-4 focus:border-[color-mix(in_oklch,var(--color-violet)_50%,transparent)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--color-violet)_28%,transparent)]"
        />

        {/* screenshot optionnel + sévérité + action */}
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          {file ? (
            <span className="inline-flex h-10 max-w-[15rem] items-center gap-2 rounded-md border border-[color-mix(in_oklch,var(--color-emerald)_40%,transparent)] bg-surface-2/50 px-3 text-[0.82rem] text-ink-1">
              <ImagePlus className="size-4 shrink-0 text-emerald-hi" strokeWidth={2} />
              <span className="truncate">{file.name}</span>
              <button type="button" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ""; }} aria-label="Retirer le screenshot" className="grid size-5 shrink-0 place-items-center rounded text-ink-3 hover:text-ink-1">
                <X className="size-3.5" strokeWidth={2.5} />
              </button>
            </span>
          ) : (
            <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border border-line-strong bg-surface-2/40 px-3 text-[0.82rem] font-medium text-ink-2 transition-colors hover:border-[color-mix(in_oklch,var(--color-violet)_40%,transparent)] hover:text-ink-1">
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <ImagePlus className="size-4" strokeWidth={2} />
              Screenshot
            </label>
          )}

          {/* sévérité (pour un ajout direct exo/note ; le minage la déduit) */}
          <div className="inline-flex items-center gap-1" role="group" aria-label="Sévérité (pour un ajout direct)">
            {[1, 2, 3].map((lv) => {
              const meta = SEVERITY[sevOf(lv)];
              return (
                <button
                  key={lv}
                  type="button"
                  onClick={() => setSev(lv)}
                  aria-pressed={sev === lv}
                  title={`Sévérité : ${meta.label}`}
                  className={cn(
                    "inline-flex h-10 items-center gap-1.5 rounded-md border px-2.5 text-[0.8rem] font-medium transition-colors",
                    sev === lv
                      ? "border-[color-mix(in_oklch,var(--color-violet)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-violet)_14%,transparent)] text-ink-1"
                      : "border-line bg-surface-2/40 text-ink-3 hover:text-ink-1"
                  )}
                >
                  <meta.Icon className="size-3.5" strokeWidth={2.25} />
                  <span className="hidden sm:inline">{meta.label}</span>
                </button>
              );
            })}
          </div>

          <Button variant="primary" onClick={submit} loading={busy} className="ml-auto">
            {!busy && <Sparkles className="size-4" strokeWidth={2.5} />}
            {busy ? "Ajout…" : "Ajouter au suivi"}
          </Button>
        </div>

        <p className="mt-2 text-[0.74rem] text-ink-4">
          Longue discussion → Cortex en extrait tes lacunes. Screenshot ou note courte → ajout direct (marche hors-ligne).
        </p>

        {savedMsg && (
          <p className="mt-3 inline-flex items-center gap-1.5 text-[0.82rem] text-emerald-hi" aria-live="polite">
            <Check className="size-3.5" strokeWidth={2.5} /> {savedMsg}
          </p>
        )}
        {note && <p className="mt-3 text-[0.82rem] text-ink-3" aria-live="polite">{note}</p>}
        {error && (
          <div
            role="alert"
            className={cn(
              "mt-3 flex items-start gap-2.5 rounded-lg border p-3 text-[0.84rem] leading-relaxed",
              error.offline
                ? "border-[color-mix(in_oklch,var(--color-warning)_38%,transparent)] bg-[color-mix(in_oklch,var(--color-warning)_8%,transparent)] text-ink-2"
                : "border-[color-mix(in_oklch,var(--color-danger)_38%,transparent)] bg-[color-mix(in_oklch,var(--color-danger)_8%,transparent)] text-ink-2"
            )}
          >
            {error.offline ? <CloudOff className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={2} /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger-hi" strokeWidth={2} />}
            {error.message}
          </div>
        )}

        {/* lacunes extraites d'une discussion (déjà suivies côté back) */}
        {mined && mined.length > 0 && (
          <div className="mt-4 border-t border-line pt-4">
            <div className="mb-3 text-[0.8rem] font-medium text-ink-2">
              {mined.length} lacune{mined.length > 1 ? "s" : ""} extraite{mined.length > 1 ? "s" : ""} et suivie{mined.length > 1 ? "s" : ""}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {mined.map((m, i) => {
                const sevm = SEVERITY[sevOf(m.severity)];
                return (
                  <div key={`${m.topic}-${i}`} className="rise-in rounded-lg border border-line bg-surface-2/40 p-4" style={{ animationDelay: `${i * 80}ms` }}>
                    <div className="flex items-start gap-3">
                      <SeverityMeter level={sevm.level} tone={sevm.tone} className="mt-1 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <h3 className="text-[0.92rem] font-semibold text-ink-1">{m.topic}</h3>
                        <p className="mt-0.5 text-[0.8rem] text-ink-3">{m.concept}</p>
                        {m.theme && (
                          <span className="mt-2 inline-block rounded-full border border-line bg-surface-1/60 px-2 py-0.5 text-[0.7rem] text-ink-3">{m.theme}</span>
                        )}
                      </div>
                      <Badge tone={sevm.tone} Icon={sevm.Icon} size="xs">{sevm.label}</Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
