"use client";

import { useRef, useState } from "react";
import {
  Sparkles,
  ClipboardPaste,
  ImagePlus,
  Check,
  CloudOff,
  AlertTriangle,
} from "lucide-react";
import { SEVERITY, type Severity } from "@/lib/ux/labels";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SeverityMeter } from "@/components/viz/SeverityMeter";
import { apiPost, useCourse, type ApiError } from "@/lib/ux/api";
import { sevOf, type MineResp, type MinedItem } from "@/lib/ux/weaknesses";
import { cn } from "@/lib/ux/cn";

type Tab = "paste" | "shot";

/**
 * Ajout RÉEL d'une lacune :
 * — « Coller » → POST /api/weaknesses/mine (Claude Max ; 503 géré proprement).
 *   Les lacunes extraites sont créées côté back → on affiche le résultat et on refetch.
 * — « Screenshot / note » → POST /api/weaknesses (FormData : image + note + sévérité).
 */
export function WeaknessInbox({ onAdded }: { onAdded: () => void }) {
  const { courseId } = useCourse();
  const [tab, setTab] = useState<Tab>("paste");

  // — Coller une discussion —
  const [text, setText] = useState("");
  const [mining, setMining] = useState(false);
  const [mined, setMined] = useState<MinedItem[] | null>(null);
  const [mineNote, setMineNote] = useState<string | null>(null);
  const [mineError, setMineError] = useState<{ offline: boolean; message: string } | null>(null);

  // — Screenshot / note manuelle —
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [sev, setSev] = useState(2);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const mine = async () => {
    if (mining) return;
    setMineError(null);
    setMineNote(null);
    setMined(null);
    if (text.trim().length < 40) {
      setMineError({ offline: false, message: "Colle une discussion (au moins quelques échanges)." });
      return;
    }
    setMining(true);
    try {
      const d = await apiPost<MineResp>("/api/weaknesses/mine", courseId, { text });
      setMined(d.mined ?? []);
      if (d.created === 0) setMineNote(d.note ?? "Aucune faiblesse claire détectée dans cette discussion.");
      else {
        setText("");
        onAdded();
      }
    } catch (e) {
      const err = e as ApiError;
      setMineError({
        offline: err.status === 503,
        message:
          err.status === 503
            ? "Claude Max n’est pas joignable. Lance Cortex sur ta machine connectée, puis réessaie — ta discussion reste dans le champ."
            : err.message || "L’analyse a échoué. Réessaie.",
      });
    } finally {
      setMining(false);
    }
  };

  const save = async () => {
    if (saving) return;
    setSaveError(null);
    setSavedMsg(null);
    if (!file && !note.trim()) {
      setSaveError("Mets au moins un screenshot ou une note.");
      return;
    }
    setSaving(true);
    try {
      const form = new FormData();
      if (note.trim()) form.append("description", note.trim());
      form.append("severity", String(sev));
      if (file) form.append("screenshot", file);
      const res = await fetch(`/api/weaknesses?course=${encodeURIComponent(courseId)}`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Erreur ${res.status}`);
      }
      setFile(null);
      setNote("");
      if (fileRef.current) fileRef.current.value = "";
      setSavedMsg("Lacune ajoutée au suivi — Cortex l’analysera pour la relier au cours.");
      onAdded();
    } catch (e) {
      setSaveError((e as Error).message || "L’ajout a échoué. Réessaie.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="panel accent-field relative overflow-hidden rounded-xl p-5 sm:p-6"
      
      aria-labelledby="inbox-title"
    >
      <div
        className="pointer-events-none absolute -right-24 -top-24 size-56 rounded-full opacity-50 blur-3xl"
        style={{
          background:
            "radial-gradient(circle, color-mix(in oklch, var(--color-violet) 40%, transparent), transparent 70%)",
        }}
        aria-hidden="true"
      />

      <div className="relative">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-violet-hi" strokeWidth={2.5} />
          <h2 id="inbox-title" className="text-[1.05rem] font-semibold text-ink-1">
            Ajoute une lacune
          </h2>
        </div>
        <p className="mt-1 text-[0.88rem] text-ink-2">
          Colle une discussion ou dépose un exo raté — Cortex en extrait tes lacunes précises.
        </p>

        {/* tabs */}
        <div className="mt-4 inline-flex items-center gap-1 rounded-lg border border-line bg-surface-1/60 p-1">
          <TabBtn active={tab === "paste"} onClick={() => setTab("paste")} Icon={ClipboardPaste}>
            Coller une discussion
          </TabBtn>
          <TabBtn active={tab === "shot"} onClick={() => setTab("shot")} Icon={ImagePlus}>
            Screenshot / note
          </TabBtn>
        </div>

        {tab === "paste" ? (
          <>
            <div className="mt-3">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
                aria-label="Discussion à analyser"
                placeholder="Colle ici une discussion (ChatGPT, Slack, notes)… Cortex en déduit tes lacunes."
                className="w-full resize-none rounded-lg border border-line-strong bg-surface-2/40 p-3.5 text-[0.9rem] text-ink-1 placeholder:text-ink-4 focus:border-[color-mix(in_oklch,var(--color-violet)_50%,transparent)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--color-violet)_28%,transparent)]"
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={mine} loading={mining}>
                {!mining && <Sparkles className="size-4" strokeWidth={2.5} />}
                {mining ? "Analyse en cours…" : "Extraire les lacunes"}
              </Button>
              {mined && mined.length > 0 && (
                <span className="text-[0.82rem] text-ink-3" aria-live="polite">
                  <span className="font-semibold text-emerald-hi">{mined.length} lacune{mined.length > 1 ? "s" : ""}</span>{" "}
                  extraite{mined.length > 1 ? "s" : ""} et ajoutée{mined.length > 1 ? "s" : ""} au suivi.
                </span>
              )}
              {mineNote && (
                <span className="text-[0.82rem] text-ink-3" aria-live="polite">{mineNote}</span>
              )}
            </div>
            {mineError && (
              <div
                role="alert"
                className={cn(
                  "mt-3 flex items-start gap-2.5 rounded-lg border p-3 text-[0.84rem] leading-relaxed",
                  mineError.offline
                    ? "border-[color-mix(in_oklch,var(--color-warning)_38%,transparent)] bg-[color-mix(in_oklch,var(--color-warning)_8%,transparent)] text-ink-2"
                    : "border-[color-mix(in_oklch,var(--color-danger)_38%,transparent)] bg-[color-mix(in_oklch,var(--color-danger)_8%,transparent)] text-ink-2"
                )}
              >
                {mineError.offline ? (
                  <CloudOff className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={2} />
                ) : (
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger-hi" strokeWidth={2} />
                )}
                {mineError.message}
              </div>
            )}

            {/* lacunes extraites (déjà suivies côté back) */}
            {mined && mined.length > 0 && (
              <div className="mt-4 border-t border-line pt-4">
                <div className="mb-3 text-[0.72rem] font-medium uppercase tracking-wider text-ink-3">
                  Lacunes détectées
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {mined.map((m, i) => {
                    const sevm = SEVERITY[sevOf(m.severity)];
                    return (
                      <div
                        key={`${m.topic}-${i}`}
                        className="rise-in rounded-lg border border-line bg-surface-2/40 p-4"
                        style={{ animationDelay: `${i * 80}ms` }}
                      >
                        <div className="flex items-start gap-3">
                          <SeverityMeter level={sevm.level} tone={sevm.tone} className="mt-1 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <h3 className="text-[0.92rem] font-semibold text-ink-1">{m.topic}</h3>
                            <p className="mt-0.5 text-[0.8rem] text-ink-3">{m.concept}</p>
                            {m.theme && (
                              <span className="mt-2 inline-block rounded-full border border-line bg-surface-1/60 px-2 py-0.5 text-[0.7rem] text-ink-3">
                                {m.theme}
                              </span>
                            )}
                          </div>
                          <Badge tone={sevm.tone} Icon={sevm.Icon} size="xs">
                            {sevm.label}
                          </Badge>
                        </div>
                        <p className="mt-3 inline-flex items-center gap-1.5 text-[0.78rem] text-emerald-hi">
                          <Check className="size-3.5" strokeWidth={2.5} /> Suivie
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <label
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-7 text-center transition-colors",
                  file
                    ? "border-[color-mix(in_oklch,var(--color-emerald)_45%,transparent)] bg-surface-2/50"
                    : "border-line-strong bg-surface-2/30 hover:border-[color-mix(in_oklch,var(--color-violet)_45%,transparent)] hover:bg-surface-2/50"
                )}
              >
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  className="sr-only"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                <ImagePlus className={cn("size-6", file ? "text-emerald-hi" : "text-ink-3")} strokeWidth={1.75} />
                <span className="text-[0.9rem] font-medium text-ink-1">
                  {file ? file.name : "Choisir un screenshot d’exo raté"}
                </span>
                <span className="text-[0.78rem] text-ink-3">PNG, JPG, GIF ou WebP — max 12 Mo</span>
              </label>

              <div className="flex flex-col gap-3">
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  aria-label="Note sur la lacune (optionnelle si screenshot)"
                  placeholder="Note (optionnelle) : ce qui t’a piégé, l’énoncé, la question…"
                  className="w-full flex-1 resize-none rounded-lg border border-line-strong bg-surface-2/40 p-3 text-[0.88rem] text-ink-1 placeholder:text-ink-4 focus:border-[color-mix(in_oklch,var(--color-violet)_50%,transparent)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--color-violet)_28%,transparent)]"
                />
                <div className="flex items-center gap-2" role="group" aria-label="Sévérité de la lacune">
                  {[1, 2, 3].map((lv) => {
                    const meta = SEVERITY[sevOf(lv)];
                    return (
                      <button
                        key={lv}
                        type="button"
                        onClick={() => setSev(lv)}
                        aria-pressed={sev === lv}
                        className={cn(
                          "inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border text-[0.8rem] font-medium transition-colors",
                          sev === lv
                            ? "border-[color-mix(in_oklch,var(--color-violet)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-violet)_14%,transparent)] text-ink-1"
                            : "border-line bg-surface-2/40 text-ink-3 hover:text-ink-1"
                        )}
                      >
                        <meta.Icon className="size-3.5" strokeWidth={2.25} />
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={save} loading={saving}>
                {saving ? "Ajout…" : "Ajouter au suivi"}
              </Button>
              {savedMsg && (
                <span className="inline-flex items-center gap-1.5 text-[0.82rem] text-emerald-hi" aria-live="polite">
                  <Check className="size-3.5" strokeWidth={2.5} />
                  {savedMsg}
                </span>
              )}
            </div>
            {saveError && (
              <p role="alert" className="mt-2 text-[0.82rem] text-danger-hi">
                {saveError}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function TabBtn({
  active,
  onClick,
  Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-md px-3 text-[0.82rem] font-medium transition-colors",
        active ? "bg-surface-2 text-ink-1 ring-1 ring-line-strong" : "text-ink-3 hover:text-ink-1"
      )}
    >
      <Icon className="size-4" strokeWidth={2} />
      {children}
    </button>
  );
}
