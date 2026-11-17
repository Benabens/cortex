"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, CloudOff, AlertTriangle, FileText, Paperclip, X } from "lucide-react";
import { SEVERITY } from "@/lib/ux/labels";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Segmented, type SegmentedOption } from "@/components/ui/Segmented";
import { SeverityMeter } from "@/components/viz/SeverityMeter";
import { apiPost, useCourse, type ApiError, engineDown } from "@/lib/ux/api";
import { sevOf, type MineResp, type MinedItem } from "@/lib/ux/weaknesses";
import { cn } from "@/lib/ux/cn";
import { useTranslations } from "use-intl/react";
import { useFmt } from "@/lib/i18n/use-fmt";

const MIN_MINE_CHARS = 40; // au-delà = « discussion » à miner (seuil back = mine/route.ts)
const MAX_FILE_BYTES = 12 * 1024 * 1024; // même plafond que le back (lib/weakness-files)
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const ACCEPT = ".pdf,application/pdf,image/png,image/jpeg,image/gif,image/webp";

const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
const isAccepted = (f: File) => isPdf(f) || IMAGE_TYPES.includes(f.type);
/**
 * « Ajoute ce qui t'a piégé » : UNE seule zone qui accepte tout (décision du 28/09, série 3).
 *  — texte collé : énoncé ou discussion (≥ 40 car.) → POST /api/weaknesses/mine (le moteur extrait les lacunes) ;
 *  — PDF glissé, collé ou choisi → même route en multipart : son texte est extrait sur le serveur et
 *    analysé comme un texte collé ; un scan sans texte rejoint le suivi tel quel ;
 *  — capture (⌘V) ou image PNG/JPG → POST /api/weaknesses (ajout direct, marche hors-ligne) ;
 *  — note courte → POST /api/weaknesses.
 * Le glisser-déposer est une amélioration : le bouton « Choisir un fichier » ouvre un vrai sélecteur
 * (clavier, lecteur d'écran, mobile). La sévérité reste, en petit texte discret à côté du bouton.
 */
export function WeaknessInbox({ onAdded }: { onAdded: () => void }) {
  const t = useTranslations("weaknessInbox");
  const labelsT = useTranslations("labels");
  const f = useFmt();
  /** Les trois niveaux de sévérité (1 à 3), dans l'ordre du back. */
  const severityLevels: SegmentedOption<string>[] = [1, 2, 3].map((lv) => ({
    value: String(lv), label: labelsT(SEVERITY[sevOf(lv)].labelKey),
  }));
  const { courseId, course } = useCourse();
  const language = course?.language || undefined; // "" = langue pas encore détectée : pas de lang vide
  const sizeLabel = (n: number) => n >= 1024 * 1024
    ? t("sizeMb", { size: f.number(n / 1024 / 1024, 1) })
    : t("sizeKb", { size: f.number(Math.max(1, Math.round(n / 1024))) });
  const inputId = useId();
  const statusId = useId();
  const fileRef = useRef<HTMLInputElement>(null);

  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [sev, setSev] = useState(2);
  const [busy, setBusy] = useState(false);
  const [mined, setMined] = useState<MinedItem[] | null>(null);
  const [note, setNote] = useState<string | null>(null); // note d'info (ex. « aucune lacune détectée »)
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<{ offline: boolean; message: string } | null>(null);

  // Aperçu d'image : object URL dérivé du fichier, révoqué quand il change (pas de fuite mémoire).
  const preview = useMemo(() => (file && !isPdf(file) ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const reset = () => { setError(null); setNote(null); setSavedMsg(null); setMined(null); };

  /** Accepte une pièce jointe (image ou PDF) ; refuse le reste avec un message clair. */
  const attach = (f: File | null | undefined): boolean => {
    if (!f) return false;
    if (!isAccepted(f)) {
      setError({ offline: false, message: t("unsupportedFormat") });
      return false;
    }
    if (f.size > MAX_FILE_BYTES) {
      setError({ offline: false, message: t("tooLarge") });
      return false;
    }
    setError(null);
    setFile(f);
    return true;
  };

  const clearFile = () => {
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const saveWeakness = async (description: string) => {
    const form = new FormData();
    if (description) form.append("description", description);
    form.append("severity", String(sev));
    if (file) form.append("file", file);
    const res = await fetch(`/api/weaknesses?course=${encodeURIComponent(courseId)}`, { method: "POST", body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw { status: res.status, message: body?.error ?? t("httpError", { status: res.status }), code: typeof body?.code === "string" ? body.code : null, params: body?.params } as ApiError;
    }
    setText("");
    clearFile();
    setSavedMsg(t("saved"));
    onAdded();
  };

  const showMined = (d: MineResp) => {
    setMined(d.mined ?? []);
    if (d.created === 0) setNote(d.note ?? t("noneDetected"));
    if (d.created > 0 || d.stored) { setText(""); clearFile(); onAdded(); }
  };

  const mineText = async (content: string) => showMined(await apiPost<MineResp>("/api/weaknesses/mine", courseId, { text: content }));

  const minePdf = async (pdf: File, content: string) => {
    const form = new FormData();
    form.append("file", pdf);
    if (content) form.append("text", content);
    form.append("severity", String(sev));
    const res = await fetch(`/api/weaknesses/mine?course=${encodeURIComponent(courseId)}`, { method: "POST", body: form });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw { status: res.status, message: body?.error ?? t("httpError", { status: res.status }), code: typeof body?.code === "string" ? body.code : null, params: body?.params } as ApiError;
    showMined(body as MineResp);
  };

  const submit = async () => {
    if (busy) return;
    reset();
    const content = text.trim();
    if (!file && !content) {
      setError({ offline: false, message: t("inputRequired") });
      return;
    }
    setBusy(true);
    try {
      if (file && isPdf(file)) await minePdf(file, content); // PDF → texte extrait puis analysé
      else if (file) await saveWeakness(content); // capture / image (+ note) → ajout direct, hors-ligne OK
      else if (content.length >= MIN_MINE_CHARS) await mineText(content); // énoncé ou discussion → extraction
      else await saveWeakness(content); // note courte → ajout manuel
    } catch (e) {
      const err = e as ApiError;
      setError({
        offline: engineDown(err),
        message:
          engineDown(err)
            ? t("llmUnavailable")
            : err.message || t("addFailed"),
      });
    } finally {
      setBusy(false);
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    for (const it of Array.from(e.clipboardData?.items ?? [])) {
      if (it.kind !== "file") continue;
      const f = it.getAsFile();
      if (f && attach(f)) { e.preventDefault(); return; } // fichier collé → pas de texte parasite
    }
  };

  return (
    <section className="d2-card relative overflow-hidden p-5 sm:p-7" aria-labelledby="inbox-title">
      <h2 id="inbox-title" className="text-xl font-semibold text-ink-1">
        <label htmlFor={inputId}>{t("title")}</label>
      </h2>

      {/* Zone de dépôt unique : texte, capture collée, PDF ou image glissés. */}
      <div
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); setDragOver(true); }
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
        onDrop={(e) => {
          const f = e.dataTransfer.files?.[0];
          if (f) { e.preventDefault(); attach(f); }
          setDragOver(false);
        }}
        className={cn(
          "mt-5 flex min-h-[190px] flex-col rounded-2xl border-[1.5px] border-dashed transition-colors",
          "focus-within:border-[color-mix(in_oklch,var(--color-accent)_55%,transparent)]",
          dragOver
            ? "border-[color-mix(in_oklch,var(--color-accent)_65%,transparent)] bg-[color-mix(in_oklch,var(--color-accent)_7%,transparent)]"
            : "border-line-strong bg-bg/40"
        )}
      >
        {file && (
          <div className="flex items-center gap-3 px-3.5 pt-3.5">
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt={t("previewAlt")} className="size-14 rounded-lg border border-line object-cover" />
            ) : (
              <span className="grid size-14 place-items-center rounded-lg border border-line bg-surface-2 text-ink-2" aria-hidden="true">
                <FileText className="size-6" strokeWidth={1.75} />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.85rem] text-ink-1">{file.name || t("pastedCapture")}</span>
              <span className="block text-[0.75rem] text-ink-3">
                {isPdf(file) ? "PDF" : t("image")} · {sizeLabel(file.size)}
              </span>
            </span>
            <button
              type="button"
              onClick={clearFile}
              aria-label={t("removeFile", { name: file.name || t("capture") })}
              className="grid size-11 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-1"
            >
              <X className="size-4" strokeWidth={2.25} />
            </button>
          </div>
        )}

        <textarea
          id={inputId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); } }}
          placeholder={t("placeholder")}
          aria-describedby={statusId}
          rows={4}
          data-focus-parent
          className="w-full flex-1 resize-none bg-transparent px-3.5 py-3 text-[0.9rem] leading-relaxed text-ink-1 placeholder:text-ink-3 focus:outline-none"
        />

        <div className="px-2 pb-2">
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => attach(e.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-1.5 text-[0.8rem] text-ink-3 transition-colors hover:text-ink-1"
          >
            <Paperclip className="size-3.5" strokeWidth={2.25} aria-hidden="true" />
            {t("chooseFile")}
          </button>
        </div>
      </div>

      {/* Annonce de la pièce jointe pour les lecteurs d'écran. */}
      <p id={statusId} className="sr-only" aria-live="polite">
        {file ? t("attached", { name: file.name || t("capture") }) : ""}
      </p>

      {/* sévérité discrète (texte seul) + action */}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
        <Segmented
          variant="line"
          label={t("severity")}
          options={severityLevels}
          value={String(sev)}
          onChange={(v) => setSev(Number(v))}
        />

        <Button variant="primary" onClick={submit} loading={busy}>
          {busy ? t("adding") : t("add")}
        </Button>
      </div>

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

      {/* lacunes extraites d'un texte ou d'un PDF (déjà suivies côté back) */}
      {mined && mined.length > 0 && (
        <div className="mt-4 border-t border-line pt-4">
          <div className="mb-3 text-[0.8rem] font-medium text-ink-2">
            {t("mined", { count: mined.length })}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {mined.map((m, i) => {
              const sevm = SEVERITY[sevOf(m.severity)];
              return (
                <div key={`${m.topic}-${i}`} className="rise-in rounded-lg border border-line bg-surface-2/40 p-4" style={{ animationDelay: `${i * 80}ms` }}>
                  <div className="flex items-start gap-3">
                    <SeverityMeter level={sevm.level} tone={sevm.tone} className="mt-1 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-[0.92rem] font-semibold text-ink-1" lang={language}>{m.topic}</h3>
                      <p className="mt-0.5 text-[0.8rem] text-ink-3" lang={language}>{m.concept}</p>
                      {m.theme && (
                        <span className="mt-2 inline-block rounded-full border border-line bg-surface-1/60 px-2 py-0.5 text-[0.7rem] text-ink-3" lang={language}>{m.theme}</span>
                      )}
                    </div>
                    <Badge tone={sevm.tone} Icon={sevm.Icon} size="xs">{labelsT(sevm.labelKey)}</Badge>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
